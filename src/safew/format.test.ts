import { describe, expect, it } from "vitest";

import { markdownToSafewHtml } from "./format.js";

describe("markdownToSafewHtml", () => {
  it("renders basic inline formatting", () => {
    const res = markdownToSafewHtml("hi _there_ **boss** `code`");
    expect(res).toBe("hi <i>there</i> <b>boss</b> <code>code</code>");
  });

  it("renders links as Safew-safe HTML", () => {
    const res = markdownToSafewHtml("see [docs](https://example.com)");
    expect(res).toBe('see <a href="https://example.com">docs</a>');
  });

  it("escapes raw HTML", () => {
    const res = markdownToSafewHtml("<b>nope</b>");
    expect(res).toBe("&lt;b&gt;nope&lt;/b&gt;");
  });

  it("escapes unsafe characters", () => {
    const res = markdownToSafewHtml("a & b < c");
    expect(res).toBe("a &amp; b &lt; c");
  });

  it("renders paragraphs with blank lines", () => {
    const res = markdownToSafewHtml("first\n\nsecond");
    expect(res).toBe("first\n\nsecond");
  });

  it("renders lists without block HTML", () => {
    const res = markdownToSafewHtml("- one\n- two");
    expect(res).toBe("• one\n• two");
  });

  it("renders ordered lists with numbering", () => {
    const res = markdownToSafewHtml("2. two\n3. three");
    expect(res).toBe("2. two\n3. three");
  });

  it("flattens headings and blockquotes", () => {
    const res = markdownToSafewHtml("# Title\n\n> Quote");
    expect(res).toBe("Title\n\nQuote");
  });

  it("renders fenced code blocks", () => {
    const res = markdownToSafewHtml("```js\nconst x = 1;\n```");
    expect(res).toBe("<pre><code>const x = 1;\n</code></pre>");
  });
});
