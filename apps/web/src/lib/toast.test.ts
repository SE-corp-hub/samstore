// Rice Ops M11 — the toast never parses its message as HTML (names people type —
// stores, products, customers — end up in toasts). A tiny fake DOM records every
// write: the message must arrive only as a text node, and nothing may touch innerHTML.
import { test } from "node:test";
import assert from "node:assert/strict";

type Fake = { tag: string; children: Fake[]; text?: string; className: string; attrs: Record<string, string>; style: Record<string, string> };
const htmlWrites: string[] = [];

function el(tag: string): Fake & Record<string, unknown> {
  const node: Fake & Record<string, unknown> = {
    tag, children: [], className: "", attrs: {}, style: {},
    classList: { remove() {}, add() {} },
    setAttribute(k: string, v: string) { node.attrs[k] = v; },
    append(...kids: Fake[]) { node.children.push(...kids); },
    appendChild(kid: Fake) { node.children.push(kid); return kid; },
    querySelector() { return null; },
    remove() {},
  };
  for (const prop of ["innerHTML", "outerHTML"]) {
    Object.defineProperty(node, prop, { set(v: string) { htmlWrites.push(String(v)); }, get() { return ""; } });
  }
  node.insertAdjacentHTML = (_pos: string, html: string) => { htmlWrites.push(html); };
  return node;
}

const body = el("body");
(globalThis as unknown as Record<string, unknown>).window = {};
(globalThis as unknown as Record<string, unknown>).document = {
  body,
  createElement: (tag: string) => el(tag),
  createTextNode: (text: string) => ({ tag: "#text", children: [], text, className: "", attrs: {}, style: {} }),
};

const textOf = (n: Fake): string => (n.tag === "#text" ? n.text ?? "" : n.children.map(textOf).join(""));
const tagsIn = (n: Fake): string[] => [n.tag, ...n.children.flatMap(tagsIn)];

test("M11: a toast shows a typed name as plain text — no HTML is ever parsed", async () => {
  const { toast } = await import("./toast.js");
  const evil = `Bigas <img src=x onerror="alert(document.cookie)"> <script>steal()</script>`;
  toast(evil);
  toast(evil, "danger");
  assert.deepEqual(htmlWrites, [], "nothing was written as HTML");
  const container = body.children[0]!;
  assert.equal(container.children.length, 2);
  for (const t of container.children) {
    assert.ok(textOf(t).includes(evil), "the exact text is shown, characters and all");
    assert.ok(!tagsIn(t).includes("img") && !tagsIn(t).includes("script"), "no element was made from the message");
  }
});
