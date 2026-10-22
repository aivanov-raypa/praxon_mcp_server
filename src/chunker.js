/**
 * Corta el texto en streaming en frases completas para que la app empiece a hablar enseguida.
 * Une frases muy cortas con la siguiente y quita el formato markdown que la voz leeria mal.
 */
const BOUNDARY = /(?:[.!?…]+["')\]]*\s+|\n+\s*)(?=\S)/g;

export function cleanForSpeech(text) {
  return text
    .replace(/^\s*[-*•]\s+/gm, '')
    .replace(/[*_`#>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export class SentenceChunker {
  #buffer = '';
  #onSentence;
  #minLength;

  constructor(onSentence, { minLength = 12 } = {}) {
    this.#onSentence = onSentence;
    this.#minLength = minLength;
  }

  push(text) {
    this.#buffer += text;
    for (;;) {
      BOUNDARY.lastIndex = 0;
      let end = -1;
      for (let m = BOUNDARY.exec(this.#buffer); m; m = BOUNDARY.exec(this.#buffer)) {
        if (cleanForSpeech(this.#buffer.slice(0, m.index + m[0].length)).length >= this.#minLength) {
          end = m.index + m[0].length;
          break;
        }
      }
      if (end < 0) return;
      this.#emit(this.#buffer.slice(0, end));
      this.#buffer = this.#buffer.slice(end);
    }
  }

  /** Emite lo que quede al terminar el mensaje. */
  flush() {
    const rest = this.#buffer;
    this.#buffer = '';
    this.#emit(rest);
  }

  #emit(raw) {
    const clean = cleanForSpeech(raw);
    if (clean) this.#onSentence(clean);
  }
}
