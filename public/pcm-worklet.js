// Toca no navegador o PCM (float32 estéreo, 48 kHz) que o app TelaViva Desktop envia no Windows.
// Tem um pequeno buffer para absorver a variação de chegada dos blocos.
class TvPcm extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = []; this.cur = null; this.pos = 0; this.size = 0; this.primed = false;
    this.port.onmessage = (e) => {
      const chunk = new Float32Array(e.data);
      this.queue.push(chunk); this.size += chunk.length;
      while (this.size > 48000 * 2 * 0.25 && this.queue.length > 1) this.size -= this.queue.shift().length; // no máximo ~250 ms de atraso
    };
  }
  process(inputs, outputs) {
    const out = outputs[0];
    const left = out[0], right = out[1] || out[0];
    if (!this.primed && this.size >= 48000 * 2 * 0.06) this.primed = true; // começa com ~60 ms de folga
    for (let i = 0; i < left.length; i++) {
      if (!this.primed) { left[i] = 0; right[i] = 0; continue; }
      if (!this.cur || this.pos >= this.cur.length) {
        this.cur = this.queue.shift(); this.pos = 0;
        if (!this.cur) { this.primed = false; left[i] = 0; right[i] = 0; continue; } // acabou o áudio: espera encher de novo
        this.size -= this.cur.length;
      }
      left[i] = this.cur[this.pos++]; right[i] = this.cur[this.pos++];
    }
    return true;
  }
}
registerProcessor('tv-pcm', TvPcm);
