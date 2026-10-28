/** Where the person is in a short flow: numbered circles, the current one filled, done ones ticked. */
export default function Steps({ items, current }: { items: string[]; current: number }) {
  return (
    <ol className="list-unstyled d-flex flex-wrap justify-content-center gap-3 gap-sm-4 mb-3" aria-label="Steps">
      {items.map((t, i) => (
        <li key={t} className={`d-flex align-items-center gap-2 ${i === current ? "fw-bold" : "text-muted"}`} aria-current={i === current ? "step" : undefined}>
          <span aria-hidden="true" className={`rounded-circle d-inline-flex align-items-center justify-content-center ${i < current ? "bg-success text-white" : i === current ? "bg-dark text-white" : "border border-secondary"}`} style={{ width: 34, height: 34 }}>
            {i < current ? <i className="bi bi-check-lg"></i> : i + 1}
          </span>
          <span>{t}</span>
        </li>
      ))}
    </ol>
  );
}
