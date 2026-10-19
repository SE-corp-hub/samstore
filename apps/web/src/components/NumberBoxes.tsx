"use client";

import { useEffect, useState, type InputHTMLAttributes } from "react";
import { DECIMALS, cleanTyping, formatOnBlur, type NumberKind } from "../lib/number-format";

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "type"> & {
  value: string;
  onChange: (value: string) => void;
  kind: NumberKind;
};

/** One number box for the whole app. Shows the decimals for its kind and tidies the value on leaving. */
export function NumberBox({ value, onChange, kind, className, ...rest }: Props) {
  const [text, setText] = useState(value);
  useEffect(() => { setText(value); }, [value]);
  const step = kind === "peso" ? "0.01" : kind === "kilo" ? "0.001" : "1";
  return (
    <input
      {...rest}
      className={className ?? "form-control"}
      type="text"
      inputMode={DECIMALS[kind] === 0 ? "numeric" : "decimal"}
      data-step={step}
      value={text}
      onChange={(e) => { const c = cleanTyping(e.target.value, kind); setText(c); onChange(c); }}
      onBlur={(e) => { const f = formatOnBlur(e.target.value, kind); setText(f); onChange(f); rest.onBlur?.(e); }}
      onFocus={(e) => { e.target.select(); rest.onFocus?.(e); }}
    />
  );
}

export const PesoInput = (p: Omit<Props, "kind">) => <NumberBox {...p} kind="peso" />;
export const KiloInput = (p: Omit<Props, "kind">) => <NumberBox {...p} kind="kilo" />;
export const WholeInput = (p: Omit<Props, "kind">) => <NumberBox {...p} kind="whole" />;
