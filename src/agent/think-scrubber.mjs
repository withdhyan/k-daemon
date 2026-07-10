const THINK_TAGS = Object.freeze(['think', 'thinking', 'reasoning', 'thought']);
const OPEN_TAGS = Object.freeze(THINK_TAGS.map((tag) => `<${tag}>`));
const CLOSE_TAGS = Object.freeze(THINK_TAGS.map((tag) => `</${tag}>`));
const ALL_TAGS = Object.freeze([...OPEN_TAGS, ...CLOSE_TAGS]);
const MAX_TAG_LENGTH = Math.max(...ALL_TAGS.map((tag) => tag.length));

export function stripThinkBlocks(text) {
  const scrubber = new StreamingThinkScrubber();
  const content = scrubber.feed(typeof text === 'string' ? text : '') + scrubber.flush();
  return Object.freeze({
    content,
    reasoning: scrubber.reasoning,
  });
}

export class StreamingThinkScrubber {
  constructor() {
    this.buffer = '';
    this.inThink = false;
    this.atLineStart = true;
    this.reasoningParts = [];
  }

  get reasoning() {
    return this.reasoningParts.join('').trim();
  }

  feed(delta) {
    if (typeof delta !== 'string' || delta.length === 0) return '';
    this.buffer += delta;
    return this.#drain(false);
  }

  flush() {
    return this.#drain(true);
  }

  #drain(final) {
    if (!this.buffer) return '';

    const hold = final ? 0 : holdbackLength(this.buffer);
    const source = hold > 0 ? this.buffer.slice(0, -hold) : this.buffer;
    this.buffer = hold > 0 ? this.buffer.slice(-hold) : '';

    let visible = '';
    let index = 0;
    while (index < source.length) {
      if (this.inThink) {
        const close = matchingTagAt(source, index, CLOSE_TAGS);
        if (close) {
          this.inThink = false;
          this.atLineStart = false;
          index += close.length;
          continue;
        }
        this.reasoningParts.push(source[index]);
        index += 1;
        continue;
      }

      const open = this.atLineStart ? matchingTagAt(source, index, OPEN_TAGS) : null;
      if (open) {
        this.inThink = true;
        this.atLineStart = false;
        index += open.length;
        continue;
      }

      const char = source[index];
      visible += char;
      this.atLineStart = char === '\n';
      index += 1;
    }

    // Any bytes left while inside a thinking block are intentionally not made
    // visible. If a closing tag arrives later, normal streaming resumes.
    if (final) this.buffer = '';
    return visible;
  }
}

function holdbackLength(source) {
  const max = Math.min(MAX_TAG_LENGTH - 1, source.length);
  for (let length = max; length > 0; length -= 1) {
    const suffix = source.slice(-length).toLowerCase();
    if (ALL_TAGS.some((tag) => tag.startsWith(suffix))) return length;
  }
  return 0;
}

function matchingTagAt(source, index, tags) {
  for (const tag of tags) {
    if (source.slice(index, index + tag.length).toLowerCase() === tag) return tag;
  }
  return null;
}
