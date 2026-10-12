/** English (or any other) dictionary for a German source dictionary: every key required, no extra keys. */
export type Messages<T> = { [K in keyof T]: string };
