/**
 * Performance Constants
 *
 * Centralized configuration for performance-related thresholds and limits.
 * These values are tuned based on real-world testing to balance functionality
 * and performance.
 *
 * @module constants/performance
 */

/**
 * Text length thresholds for different operations.
 *
 * Different thresholds are used because operations have different computational costs:
 * - Completion detection involves cursor position calculation and trigger parsing (expensive)
 * - File tag rendering involves regex matching and DOM manipulation (moderate)
 * - Text insertion via execCommand maintains undo history (very expensive for large text)
 */
export const TEXT_LENGTH_THRESHOLDS = {
  /**
   * Maximum text length for completion detection (@ / # triggers).
   *
   * Completion detection involves:
   * 1. getCursorPosition() - DOM traversal to calculate offset
   * 2. detectTrigger() - regex matching and position calculation
   * 3. getTriggerPosition() - DOM range calculations
   *
   * These operations become expensive (>50ms) beyond 10K characters.
   * Value: 10,000 characters
   */
  COMPLETION_DETECTION: 10000,

  /**
   * Maximum text length for file tag rendering.
   *
   * File tag rendering involves:
   * 1. Regex matching for @filepath patterns
   * 2. DOM tree walking to check for unrendered references
   * 3. innerHTML replacement (causes reflow)
   *
   * This is more tolerant than completion detection because it runs less frequently.
   * Value: 50,000 characters
   */
  FILE_TAG_RENDERING: 50000,

  /**
   * Threshold for switching from execCommand to Range API for text insertion.
   *
   * execCommand('insertText') is extremely slow for large text because it:
   * 1. Maintains complete undo history
   * 2. Triggers multiple DOM mutations
   * 3. Has browser-internal bookkeeping overhead
   *
   * Testing showed 6+ seconds for 50KB text with execCommand vs <100ms with Range API.
   * Trade-off: Range API doesn't support native undo, but performance is critical for paste.
   * Value: 5,000 characters
   */
  LARGE_TEXT_INSERTION: 5000,
} as const;

/**
 * Rendering limits to prevent UI freeze.
 */
export const RENDERING_LIMITS = {
  /**
   * Maximum file tags to render per operation.
   *
   * Each file tag involves:
   * 1. Icon lookup and SVG generation
   * 2. HTML attribute escaping
   * 3. DOM element creation
   *
   * Beyond 50 tags, rendering time exceeds acceptable thresholds (>100ms).
   * Users with >50 file references should use a file list component instead.
   * Value: 50 tags
   */
  MAX_FILE_TAGS_PER_RENDER: 50,
} as const;

/**
 * Performance timing configuration for debug utilities.
 */
export const PERF_TIMING = {
  /**
   * Minimum operation time (ms) to log in performance debug mode.
   *
   * Operations faster than this are considered "fast enough" and not logged
   * to reduce console noise during debugging.
   * Value: 5ms
   */
  MIN_LOG_THRESHOLD_MS: 5,

  /**
   * Threshold (ms) for highlighting slow operations in red.
   *
   * Operations exceeding this time are likely causing user-perceptible lag
   * and should be investigated.
   * Value: 50ms
   */
  SLOW_OPERATION_THRESHOLD_MS: 50,
} as const;

/**
 * Type definitions for external consumers
 */
export type TextLengthThresholds = typeof TEXT_LENGTH_THRESHOLDS;
export type RenderingLimits = typeof RENDERING_LIMITS;
export type PerfTiming = typeof PERF_TIMING;
