import type { KnowledgeLevel } from '../types'

/**
 * A clickable 1-5 star row for "knowledge level" (1 = never seen it before,
 * 5 = mastered, can play it at any time). Clicking a star sets the level to
 * that star's position; clicking the currently-set star again clears it back
 * to unrated. Shared by every place a rating can be seen or changed (library
 * list rows, the folder tree, and the practice view's toolbar) so the
 * click-to-set/click-to-clear behavior is identical everywhere.
 */
export class RatingStars {
  readonly el: HTMLSpanElement
  private level: KnowledgeLevel | null = null
  private onChangeCallback: ((level: KnowledgeLevel | null) => void) | null = null

  constructor() {
    this.el = document.createElement('span')
    this.el.className = 'rating-stars'
    this.render()
  }

  onChange(callback: (level: KnowledgeLevel | null) => void): void {
    this.onChangeCallback = callback
  }

  setLevel(level: KnowledgeLevel | null): void {
    this.level = level
    this.render()
  }

  getLevel(): KnowledgeLevel | null {
    return this.level
  }

  private render(): void {
    this.el.innerHTML = ''
    for (let i = 1; i <= 5; i++) {
      const star = document.createElement('button')
      star.type = 'button'
      star.className = 'rating-star'
      const filled = this.level !== null && i <= this.level
      star.classList.toggle('filled', filled)
      star.innerHTML = filled ? '&#9733;' : '&#9734;'
      star.title = `Knowledge level ${i}${i === 1 ? ' (never seen it before)' : ''}${i === 5 ? ' (mastered)' : ''}`
      star.addEventListener('click', (e) => {
        e.stopPropagation()
        const next: KnowledgeLevel | null = this.level === i ? null : (i as KnowledgeLevel)
        this.setLevel(next)
        this.onChangeCallback?.(next)
      })
      this.el.appendChild(star)
    }
  }
}
