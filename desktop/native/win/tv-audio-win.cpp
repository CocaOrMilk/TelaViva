// tv-audio-win.exe — captura de áudio por programa no Windows para o TelaViva.
//
// Usa a Process Loopback API (Windows 10 versão 2004 / build 19041 ou mais nova): cada programa que está
// tocando som é capturado separadamente (PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE), mixado aqui
// com um ganho próprio ("volume da transmissão") e enviado ao Electron pela saída padrão.
// Discord (e o próprio TelaViva) ficam de fora porque nunca recebem uma captura.
//
// Protocolo (stdout, binário): quadros [tipo u8][tamanho u32 LE][dados]
//   tipo 1: PCM float32 LE, 48000 Hz, estéreo intercalado (blocos de 10 ms)
//   tipo 2: JSON {"apps":[...],"master":100}  (a cada 500 ms)
//   tipo 3: JSON {"error":"..."}              (problemas não fatais)
// Comandos (stdin, uma linha, campos separados por TAB):
//   tx <chave> <0-150> | txmute <chave> <0|1> | local <chave> <0-100> | localmute <chave> <0|1> | master <0-150> | quit
//
// Compilar (Linux, mingw-w64): ver build.sh

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <mmreg.h>
#include <mmsystem.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <audiopolicy.h>
#include <tlhelp32.h>
#include <fcntl.h>
#include <io.h>
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <deque>
#include <map>
#include <memory>
#include <mutex>
#include <set>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

// Definições que os headers do mingw-w64 ainda não trazem (iguais às do Windows SDK).
#define TV_VAD_PROCESS_LOOPBACK L"VAD\\Process_Loopback"
enum TV_ACTIVATION_TYPE { TV_ACT_DEFAULT = 0, TV_ACT_PROCESS_LOOPBACK = 1 };
enum TV_LOOPBACK_MODE { TV_INCLUDE_TREE = 0, TV_EXCLUDE_TREE = 1 };
struct TV_ACTIVATION_PARAMS { TV_ACTIVATION_TYPE type; DWORD pid; TV_LOOPBACK_MODE mode; };

static const int kRate = 48000;
static const int kChannels = 2;
static const int kBlockFrames = 480;                       // 10 ms
static const size_t kBlockFloats = kBlockFrames * kChannels;
static const size_t kMaxRingFloats = kRate * kChannels / 5;  // 200 ms de atraso no máximo por programa
static const int kIdleSeconds = 20;                          // programa sem som por 20 s: captura encerrada

using Clock = std::chrono::steady_clock;
static std::atomic<bool> g_quit{false};
static std::mutex g_outMutex;
static bool g_synthetic = false;

// ---------------------------------------------------------------- utilidades
static std::string lower(std::string s) { for (auto& c : s) c = (char)tolower((unsigned char)c); return s; }
static std::string toUtf8(const std::wstring& w) {
  if (w.empty()) return {};
  int n = WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), nullptr, 0, nullptr, nullptr);
  std::string out(n, 0);
  WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), &out[0], n, nullptr, nullptr);
  return out;
}
static std::string jsonEscape(const std::string& s) {
  std::string o;
  for (unsigned char c : s) {
    if (c == '"' || c == '\\') { o += '\\'; o += (char)c; }
    else if (c < 0x20) { char b[8]; snprintf(b, sizeof b, "\\u%04x", c); o += b; }
    else o += (char)c;
  }
  return o;
}
static void writeFrame(uint8_t type, const void* data, uint32_t len) {
  std::lock_guard<std::mutex> lock(g_outMutex);
  uint8_t header[5] = { type, (uint8_t)(len & 255), (uint8_t)((len >> 8) & 255), (uint8_t)((len >> 16) & 255), (uint8_t)((len >> 24) & 255) };
  if (fwrite(header, 1, 5, stdout) != 5 || (len && fwrite(data, 1, len, stdout) != len) || fflush(stdout) != 0) { g_quit = true; ExitProcess(0); } // Electron fechou o pipe
}
static void sendError(const std::string& message) {
  std::string j = "{\"error\":\"" + jsonEscape(message) + "\"}";
  writeFrame(3, j.data(), (uint32_t)j.size());
}

// ---------------------------------------------------------------- processos
struct ProcInfo { DWORD ppid = 0; std::string name; };
static std::map<DWORD, ProcInfo> snapshotProcs() {
  std::map<DWORD, ProcInfo> out;
  HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snap == INVALID_HANDLE_VALUE) return out;
  PROCESSENTRY32W e; e.dwSize = sizeof e;
  if (Process32FirstW(snap, &e)) do { out[e.th32ProcessID] = { e.th32ParentProcessID, lower(toUtf8(e.szExeFile)) }; } while (Process32NextW(snap, &e));
  CloseHandle(snap);
  return out;
}
static std::set<DWORD> g_excludePids;
static std::set<std::string> g_excludeNames;
static bool isExcluded(DWORD pid, const std::map<DWORD, ProcInfo>& procs) {
  DWORD cur = pid;
  for (int depth = 0; cur && depth < 32; depth++) {
    if (g_excludePids.count(cur)) return true;
    auto it = procs.find(cur);
    if (it == procs.end()) break;
    if (g_excludeNames.count(it->second.name)) return true;
    if (it->second.ppid == cur) break;
    cur = it->second.ppid;
  }
  return false;
}
// Navegadores e jogos tocam som em subprocessos: sobe até o processo "raiz" de mesmo nome.
static DWORD rootOf(DWORD pid, const std::map<DWORD, ProcInfo>& procs) {
  auto it = procs.find(pid);
  if (it == procs.end()) return pid;
  DWORD cur = pid;
  for (int depth = 0; depth < 32; depth++) {
    auto c = procs.find(cur);
    if (c == procs.end()) break;
    auto p = procs.find(c->second.ppid);
    if (p == procs.end() || p->second.name != it->second.name || c->second.ppid == cur) break;
    cur = c->second.ppid;
  }
  return cur;
}
static std::string prettyName(const std::string& exe) {
  std::string n = exe;
  if (n.size() > 4 && n.substr(n.size() - 4) == ".exe") n = n.substr(0, n.size() - 4);
  return n;
}

// ---------------------------------------------------------------- captura por processo
class ActivateHandler : public IActivateAudioInterfaceCompletionHandler {
  LONG ref_ = 1;
 public:
  HANDLE done = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  virtual ~ActivateHandler() { CloseHandle(done); }
  STDMETHODIMP QueryInterface(REFIID riid, void** ppv) override {
    if (riid == IID_IUnknown || riid == __uuidof(IActivateAudioInterfaceCompletionHandler) || riid == IID_IAgileObject) { *ppv = this; AddRef(); return S_OK; }
    *ppv = nullptr; return E_NOINTERFACE;
  }
  STDMETHODIMP_(ULONG) AddRef() override { return InterlockedIncrement(&ref_); }
  STDMETHODIMP_(ULONG) Release() override { ULONG r = InterlockedDecrement(&ref_); if (!r) delete this; return r; }
  STDMETHODIMP ActivateCompleted(IActivateAudioInterfaceAsyncOperation*) override { SetEvent(done); return S_OK; }
};

class ProcessCapture {
 public:
  DWORD pid;
  explicit ProcessCapture(DWORD p) : pid(p) {}
  ~ProcessCapture() { stop(); }

  bool start(std::string& err) {
    HRESULT hr = E_FAIL;
    // 1ª tentativa com conversão automática de formato; se o Windows recusar, 2ª sem ela.
    for (int attempt = 0; attempt < 2; attempt++) {
      IAudioClient* c = activate(err);
      if (!c) return false;
      WAVEFORMATEX fmt = {};
      fmt.wFormatTag = WAVE_FORMAT_IEEE_FLOAT; fmt.nChannels = kChannels; fmt.nSamplesPerSec = kRate;
      fmt.wBitsPerSample = 32; fmt.nBlockAlign = kChannels * 4; fmt.nAvgBytesPerSec = kRate * kChannels * 4; fmt.cbSize = 0;
      DWORD flags = AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK;
      if (attempt == 0) flags |= AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;
      hr = c->Initialize(AUDCLNT_SHAREMODE_SHARED, flags, 2000000 /*200 ms*/, 0, &fmt, nullptr);
      if (SUCCEEDED(hr)) { client_ = c; break; }
      c->Release();
    }
    if (!client_) { char b[96]; snprintf(b, sizeof b, "Initialize falhou (0x%08lx)", (unsigned long)hr); err = b; return false; }
    event_ = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    if (FAILED(client_->SetEventHandle(event_)) || FAILED(client_->GetService(__uuidof(IAudioCaptureClient), (void**)&capture_)) || FAILED(client_->Start())) {
      err = "não foi possível iniciar a captura"; stop(); return false;
    }
    run_ = true;
    thread_ = std::thread([this] { loop(); });
    return true;
  }
  void stop() {
    run_ = false;
    if (event_) SetEvent(event_);
    if (thread_.joinable()) thread_.join();
    if (client_) { client_->Stop(); client_->Release(); client_ = nullptr; }
    if (capture_) { capture_->Release(); capture_ = nullptr; }
    if (event_) { CloseHandle(event_); event_ = nullptr; }
  }
  // Entrega n floats (completando com silêncio se faltar).
  void pull(float* out, size_t n) {
    std::lock_guard<std::mutex> lock(m_);
    size_t take = std::min(n, ring_.size());
    for (size_t i = 0; i < take; i++) { out[i] = ring_.front(); ring_.pop_front(); }
    for (size_t i = take; i < n; i++) out[i] = 0.0f;
  }

 private:
  IAudioClient* activate(std::string& err) {
    TV_ACTIVATION_PARAMS ap = { TV_ACT_PROCESS_LOOPBACK, pid, TV_INCLUDE_TREE };
    PROPVARIANT pv; PropVariantInit(&pv);
    pv.vt = VT_BLOB; pv.blob.cbSize = sizeof ap; pv.blob.pBlobData = (BYTE*)&ap;
    ActivateHandler* h = new ActivateHandler();
    IActivateAudioInterfaceAsyncOperation* op = nullptr;
    HRESULT hr = ActivateAudioInterfaceAsync(TV_VAD_PROCESS_LOOPBACK, __uuidof(IAudioClient), &pv, h, &op);
    if (FAILED(hr)) { char b[96]; snprintf(b, sizeof b, "ActivateAudioInterfaceAsync falhou (0x%08lx) — Windows 10 versão 2004 ou mais nova é necessário", (unsigned long)hr); err = b; h->Release(); return nullptr; }
    WaitForSingleObject(h->done, 5000);
    HRESULT act = E_FAIL; IUnknown* unk = nullptr;
    hr = op->GetActivateResult(&act, &unk);
    op->Release(); h->Release();
    if (FAILED(hr) || FAILED(act) || !unk) { char b[96]; snprintf(b, sizeof b, "ativação recusada (0x%08lx)", (unsigned long)(FAILED(hr) ? hr : act)); err = b; return nullptr; }
    IAudioClient* c = nullptr;
    hr = unk->QueryInterface(__uuidof(IAudioClient), (void**)&c);
    unk->Release();
    if (FAILED(hr)) { err = "IAudioClient indisponível"; return nullptr; }
    return c;
  }
  void loop() {
    CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    while (run_) {
      WaitForSingleObject(event_, 100);
      UINT32 frames = 0;
      while (run_ && SUCCEEDED(capture_->GetNextPacketSize(&frames)) && frames > 0) {
        BYTE* data = nullptr; DWORD flags = 0; UINT32 got = 0;
        if (FAILED(capture_->GetBuffer(&data, &got, &flags, nullptr, nullptr))) break;
        {
          std::lock_guard<std::mutex> lock(m_);
          const float* f = (const float*)data;
          bool silent = (flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0;
          for (UINT32 i = 0; i < got * kChannels; i++) ring_.push_back(silent ? 0.0f : f[i]);
          while (ring_.size() > kMaxRingFloats) ring_.pop_front(); // limita o atraso
        }
        capture_->ReleaseBuffer(got);
      }
    }
    CoUninitialize();
  }
  IAudioClient* client_ = nullptr;
  IAudioCaptureClient* capture_ = nullptr;
  HANDLE event_ = nullptr;
  std::thread thread_;
  std::atomic<bool> run_{false};
  std::mutex m_;
  std::deque<float> ring_;
};

// ---------------------------------------------------------------- mixer
struct Prefs { double txGain = 1.0; bool txMuted = false; };
struct AppEntry {
  std::string key, name;
  DWORD rootPid = 0;
  std::unique_ptr<ProcessCapture> cap;
  bool active = false;
  Clock::time_point lastActive = Clock::now();
  int localPct = 100; bool localMuted = false;
  double phase = 0;  // modo sintético
  double freq = 440;
};
static std::mutex g_mx;
static std::map<std::string, AppEntry> g_apps;
static std::map<std::string, Prefs> g_prefs;
static double g_master = 1.0;

struct SessionRef { DWORD pid; AudioSessionState state; ISimpleAudioVolume* vol; };
static void enumerateSessions(std::vector<SessionRef>& out) {
  IMMDeviceEnumerator* en = nullptr; IMMDevice* dev = nullptr; IAudioSessionManager2* mgr = nullptr; IAudioSessionEnumerator* list = nullptr;
  if (FAILED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, __uuidof(IMMDeviceEnumerator), (void**)&en))) return;
  if (SUCCEEDED(en->GetDefaultAudioEndpoint(eRender, eMultimedia, &dev)) &&
      SUCCEEDED(dev->Activate(__uuidof(IAudioSessionManager2), CLSCTX_ALL, nullptr, (void**)&mgr)) &&
      SUCCEEDED(mgr->GetSessionEnumerator(&list))) {
    int count = 0; list->GetCount(&count);
    for (int i = 0; i < count; i++) {
      IAudioSessionControl* ctl = nullptr;
      if (FAILED(list->GetSession(i, &ctl))) continue;
      IAudioSessionControl2* c2 = nullptr;
      if (SUCCEEDED(ctl->QueryInterface(__uuidof(IAudioSessionControl2), (void**)&c2))) {
        DWORD pid = 0; AudioSessionState st = AudioSessionStateInactive;
        c2->GetProcessId(&pid); c2->GetState(&st);
        if (c2->IsSystemSoundsSession() != S_OK && pid != 0) {
          ISimpleAudioVolume* v = nullptr;
          ctl->QueryInterface(__uuidof(ISimpleAudioVolume), (void**)&v);
          out.push_back({ pid, st, v });
        }
        c2->Release();
      }
      ctl->Release();
    }
  }
  if (list) list->Release();
  if (mgr) mgr->Release();
  if (dev) dev->Release();
  en->Release();
}
static void releaseSessions(std::vector<SessionRef>& v) { for (auto& s : v) if (s.vol) s.vol->Release(); v.clear(); }

static void scanOnce() {
  auto procs = snapshotProcs();
  std::vector<SessionRef> sessions;
  enumerateSessions(sessions);
  struct Seen { DWORD root; std::string name; bool active = false; float vol = 1.0f; bool muted = true; };
  std::map<std::string, Seen> seen;
  for (auto& s : sessions) {
    if (isExcluded(s.pid, procs)) continue;
    DWORD root = rootOf(s.pid, procs);
    auto it = procs.find(root);
    if (it == procs.end()) continue;
    std::string key = it->second.name;
    Seen& e = seen[key];
    e.root = root; e.name = prettyName(key);
    if (s.state == AudioSessionStateActive) e.active = true;
    if (s.vol) { float v = 1.0f; BOOL m = FALSE; s.vol->GetMasterVolume(&v); s.vol->GetMute(&m); e.vol = std::max(e.vol == 1.0f && e.muted ? 0.0f : e.vol, v); if (!m) e.muted = false; }
    else e.muted = false;
  }
  releaseSessions(sessions);

  std::vector<std::pair<std::string, DWORD>> toStart;
  std::vector<std::unique_ptr<ProcessCapture>> toStop;
  {
    std::lock_guard<std::mutex> lock(g_mx);
    auto now = Clock::now();
    for (auto& kv : seen) {
      AppEntry& a = g_apps[kv.first];
      a.key = kv.first; a.name = kv.second.name;
      a.localPct = (int)std::lround(kv.second.vol * 100); a.localMuted = kv.second.muted;
      if (kv.second.active) { a.active = true; a.lastActive = now; } else a.active = false;
      if (a.rootPid != kv.second.root) { if (a.cap) toStop.push_back(std::move(a.cap)); a.rootPid = kv.second.root; }
      bool wanted = a.active || std::chrono::duration_cast<std::chrono::seconds>(now - a.lastActive).count() < kIdleSeconds;
      if (wanted && !a.cap) toStart.push_back({ kv.first, a.rootPid });
    }
    for (auto it = g_apps.begin(); it != g_apps.end();) {
      bool gone = !seen.count(it->first);
      bool idle = std::chrono::duration_cast<std::chrono::seconds>(now - it->second.lastActive).count() >= kIdleSeconds;
      if (gone || (!it->second.active && idle)) { if (it->second.cap) toStop.push_back(std::move(it->second.cap)); it = g_apps.erase(it); }
      else ++it;
    }
  }
  toStop.clear(); // encerra fora do lock
  for (auto& st : toStart) {
    auto cap = std::make_unique<ProcessCapture>(st.second);
    std::string err;
    bool ok = cap->start(err);
    if (!ok) { sendError("captura de " + st.first + ": " + err); cap.reset(); }
    std::lock_guard<std::mutex> lock(g_mx);
    auto it = g_apps.find(st.first);
    if (it != g_apps.end() && ok) it->second.cap = std::move(cap);
    else if (it != g_apps.end()) it->second.lastActive = Clock::now() - std::chrono::seconds(kIdleSeconds + 1); // não insiste a cada segundo
  }
}
static void scannerThread() {
  CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  while (!g_quit) { scanOnce(); for (int i = 0; i < 10 && !g_quit; i++) Sleep(100); }
  CoUninitialize();
}

static void applyLocal(const std::string& key, int pct, int mute /* -1 = não altera */) {
  auto procs = snapshotProcs();
  std::vector<SessionRef> sessions;
  enumerateSessions(sessions);
  for (auto& s : sessions) {
    if (!s.vol || isExcluded(s.pid, procs)) continue;
    auto it = procs.find(rootOf(s.pid, procs));
    if (it == procs.end() || it->second.name != key) continue;
    if (pct >= 0) s.vol->SetMasterVolume(std::min(1.0f, pct / 100.0f), nullptr);
    if (mute >= 0) s.vol->SetMute(mute ? TRUE : FALSE, nullptr);
  }
  releaseSessions(sessions);
}

static void commandThread() {
  CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  char line[512];
  while (fgets(line, sizeof line, stdin)) {
    std::string s(line);
    while (!s.empty() && (s.back() == '\n' || s.back() == '\r')) s.pop_back();
    std::vector<std::string> f; std::stringstream ss(s); std::string part;
    while (std::getline(ss, part, '\t')) f.push_back(part);
    if (f.empty()) continue;
    try {
      if (f[0] == "quit") break;
      if (f[0] == "master" && f.size() > 1) { std::lock_guard<std::mutex> l(g_mx); g_master = std::max(0, std::min(150, std::stoi(f[1]))) / 100.0; }
      else if (f[0] == "tx" && f.size() > 2) { std::lock_guard<std::mutex> l(g_mx); g_prefs[f[1]].txGain = std::max(0, std::min(150, std::stoi(f[2]))) / 100.0; }
      else if (f[0] == "txmute" && f.size() > 2) { std::lock_guard<std::mutex> l(g_mx); g_prefs[f[1]].txMuted = f[2] == "1"; }
      else if (f[0] == "local" && f.size() > 2) applyLocal(f[1], std::max(0, std::min(100, std::stoi(f[2]))), -1);
      else if (f[0] == "localmute" && f.size() > 2) applyLocal(f[1], -1, f[2] == "1" ? 1 : 0);
    } catch (...) {}
  }
  g_quit = true;
  CoUninitialize();
}

static std::string appsJson() {
  std::lock_guard<std::mutex> lock(g_mx);
  std::string j = "{\"apps\":[";
  bool first = true;
  for (auto& kv : g_apps) {
    const AppEntry& a = kv.second; Prefs p = g_prefs.count(a.key) ? g_prefs[a.key] : Prefs();
    if (!first) j += ",";
    first = false;
    char b[256];
    snprintf(b, sizeof b, "\"active\":%s,\"local\":{\"volume\":%d,\"muted\":%s},\"tx\":{\"volume\":%d,\"muted\":%s}}",
             a.active ? "true" : "false", a.localPct, a.localMuted ? "true" : "false", (int)std::lround(p.txGain * 100), p.txMuted ? "true" : "false");
    j += "{\"key\":\"" + jsonEscape(a.key) + "\",\"name\":\"" + jsonEscape(a.name) + "\"," + b;
  }
  char tail[48]; snprintf(tail, sizeof tail, "],\"master\":%d}", (int)std::lround(g_master * 100));
  return j + tail;
}

static void mixerThread() {
  std::vector<float> mix(kBlockFloats), tmp(kBlockFloats);
  auto next = Clock::now();
  int tick = 0;
  while (!g_quit) {
    next += std::chrono::milliseconds(10);
    std::this_thread::sleep_until(next);
    if (Clock::now() - next > std::chrono::milliseconds(200)) next = Clock::now(); // ficou para trás: ressincroniza
    std::fill(mix.begin(), mix.end(), 0.0f);
    {
      std::lock_guard<std::mutex> lock(g_mx);
      for (auto& kv : g_apps) {
        AppEntry& a = kv.second; Prefs p = g_prefs.count(a.key) ? g_prefs[a.key] : Prefs();
        double gain = p.txMuted ? 0.0 : p.txGain;
        if (g_synthetic) {
          for (int i = 0; i < kBlockFrames; i++) { float v = (float)(0.2 * std::sin(a.phase)); a.phase += 2 * 3.14159265358979 * a.freq / kRate; mix[i * 2] += v * (float)gain; mix[i * 2 + 1] += v * (float)gain; }
        } else if (a.cap) {
          a.cap->pull(tmp.data(), kBlockFloats);
          for (size_t i = 0; i < kBlockFloats; i++) mix[i] += tmp[i] * (float)gain;
        }
      }
      for (size_t i = 0; i < kBlockFloats; i++) { float v = mix[i] * (float)g_master; mix[i] = v > 1.0f ? 1.0f : (v < -1.0f ? -1.0f : v); }
    }
    writeFrame(1, mix.data(), (uint32_t)(kBlockFloats * sizeof(float)));
    if (++tick % 50 == 0) { std::string j = appsJson(); writeFrame(2, j.data(), (uint32_t)j.size()); }
  }
}

int main(int argc, char** argv) {
  _setmode(_fileno(stdout), _O_BINARY);
  _setmode(_fileno(stdin), _O_BINARY);
  setvbuf(stdout, nullptr, _IONBF, 0);
  for (int i = 1; i < argc; i++) {
    std::string a = argv[i];
    if (a == "--synthetic") g_synthetic = true;
    else if (a == "--exclude-pid" && i + 1 < argc) g_excludePids.insert((DWORD)std::stoul(argv[++i]));
    else if (a == "--exclude-names" && i + 1 < argc) { std::stringstream ss(argv[++i]); std::string n; while (std::getline(ss, n, ',')) if (!n.empty()) g_excludeNames.insert(lower(n)); }
    else if (a == "--version") { printf("tv-audio-win 1.0\n"); return 0; }
  }
  timeBeginPeriod(1);
  if (g_synthetic) {
    std::lock_guard<std::mutex> lock(g_mx);
    for (auto [k, n, f] : { std::tuple<const char*, const char*, double>{ "jogo_teste", "Jogo (teste)", 440 }, { "musica_teste", "Musica (teste)", 660 } }) {
      AppEntry& a = g_apps[k]; a.key = k; a.name = n; a.active = true; a.freq = f;
    }
  } else {
    CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  }
  std::thread cmd(commandThread);
  std::thread scan;
  if (!g_synthetic) scan = std::thread(scannerThread);
  std::thread mixer(mixerThread);
  cmd.join();
  g_quit = true;
  mixer.join();
  if (scan.joinable()) scan.join();
  { std::lock_guard<std::mutex> lock(g_mx); for (auto& kv : g_apps) kv.second.cap.reset(); }
  return 0;
}
