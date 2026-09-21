// P6b: Messenger reply templates — pure builders for the journey engine.
// These are DATA (what a real provider would send); the suppressed/mock adapter
// consumes them. No live Meta calls are ever made here.

export interface QuickReply {
  title: string;
  payload: string; // what the journey engine matches on
}

export interface TemplateButton {
  title: string;
  payload: string; // postback payload
}

export interface TextTemplate {
  type: "text";
  text: string;
  quickReplies?: QuickReply[];
}

export interface ButtonTemplate {
  type: "button";
  text: string;
  buttons: TemplateButton[];
}

export interface CarouselElement {
  title: string;
  subtitle: string;
  imageUrl: string | null;
  buttons: TemplateButton[];
}

export interface CarouselTemplate {
  type: "carousel";
  elements: CarouselElement[];
}

export interface ImageTemplate {
  type: "image";
  imageUrl: string;
}

export type ReplyTemplate = TextTemplate | ButtonTemplate | CarouselTemplate | ImageTemplate;

export function text(text: string, quickReplies: QuickReply[] = []): TextTemplate {
  return { type: "text", text, quickReplies: quickReplies.length ? quickReplies : undefined };
}

export function button(text_: string, buttons: TemplateButton[]): ButtonTemplate {
  return { type: "button", text: text_, buttons };
}

export function carousel(elements: CarouselElement[]): CarouselTemplate {
  return { type: "carousel", elements };
}

/** Standard journey quick replies. */
export const MENU_REPLIES: QuickReply[] = [
  { title: "Browse menu", payload: "menu" },
  { title: "Track order", payload: "track" },
  { title: "Store info", payload: "info" },
];

export function truncate(s: string, n = 80): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}