/** Rounds to one decimal so emitted path data stays short and stable. */
export const r1 = (value) => Math.round(value * 10) / 10;

/** Escapes text and double-quoted attributes at the final markup boundary. */
export const esc = (value) =>
  String(value).replace(
    /[&<>"]/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
      })[character],
  );

/** A version is dead when it will never be re-run as-is. */
export const DEAD = new Set(["rejected", "withdrawn", "superseded"]);

/** The same head drives defaults in markup and generated selection rules. */
export const headOf = (tree) =>
  tree.nodes.find((node) => node.id === tree.stats.head) ?? tree.nodes[0];

/** Encode URL components first; callers escape the complete URL for markup. */
const hashscanUrl = (topic, kind, value) =>
  `https://hashscan.io/${encodeURIComponent(topic.network)}/${kind}/${encodeURIComponent(value)}`;

export const hashscanRecord = (topic, reference) =>
  reference.timestamp
    ? hashscanUrl(topic, "transaction", reference.timestamp)
    : hashscanUrl(topic, "topic", topic.topicId);

export const hashscanTopic = (topic) => hashscanUrl(topic, "topic", topic.topicId);
