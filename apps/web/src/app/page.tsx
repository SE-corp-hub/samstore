import Link from "next/link";

export default function Home() {
  return (
    <div className="landing">
      {/* Navbar */}
      <nav className="navbar navbar-dark bg-dark sticky-top">
        <div className="container">
          <Link href="/" className="navbar-brand fw-semibold">
            <i className="bi bi-shop me-2"></i>Sam&apos;s Store
          </Link>
          <div className="d-flex gap-2">
            <Link href="/sam-store" className="btn btn-outline-light btn-sm">
              <i className="bi bi-cart3 me-1"></i>Order now
            </Link>
            <Link href="/admin/login" className="btn btn-outline-light btn-sm">
              <i className="bi bi-speedometer2 me-1"></i>Admin
            </Link>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <header className="hero py-5 text-center text-white">
        <div className="container py-4">
          <h1 className="display-4 fw-bold mb-3">Fresh Filipino favorites<br />delivered to your door</h1>
          <p className="lead mb-4 mx-auto" style={{ maxWidth: 560 }}>
            Order Kape Barako, Turon, Bibingka and more — cash on delivery, no account needed.
          </p>
          <Link href="/sam-store" className="btn btn-primary btn-lg px-4">
            <i className="bi bi-bag-check me-2"></i>Start ordering
          </Link>
        </div>
      </header>

      {/* Features */}
      <section className="py-5">
        <div className="container">
          <div className="row g-4 text-center">
            <div className="col-md-4">
              <div className="card h-100 border-0 shadow-sm">
                <div className="card-body">
                  <i className="bi bi-phone fs-1 text-primary d-block mb-2"></i>
                  <h6 className="fw-semibold">Order from your phone</h6>
                  <p className="text-muted small mb-0">A fast, mobile-first storefront. No app, no sign-up.</p>
                </div>
              </div>
            </div>
            <div className="col-md-4">
              <div className="card h-100 border-0 shadow-sm">
                <div className="card-body">
                  <i className="bi bi-cash-coin fs-1 text-primary d-block mb-2"></i>
                  <h6 className="fw-semibold">Cash on delivery</h6>
                  <p className="text-muted small mb-0">Pay when it arrives. Simple and safe.</p>
                </div>
              </div>
            </div>
            <div className="col-md-4">
              <div className="card h-100 border-0 shadow-sm">
                <div className="card-body">
                  <i className="bi bi-people fs-1 text-primary d-block mb-2"></i>
                  <h6 className="fw-semibold">Local &amp; fresh</h6>
                  <p className="text-muted small mb-0">Made to order by your favourite neighborhood store.</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Product teaser */}
      <section className="py-5 bg-light">
        <div className="container text-center">
          <h2 className="h4 mb-4">What&apos;s on the menu</h2>
          <div className="row g-3 justify-content-center">
            {[
              { name: "Kape Barako", emoji: "☕", desc: "Strong Filipino coffee" },
              { name: "Turon (4 pcs)", emoji: "🍌", desc: "Fried banana rolls" },
              { name: "Bibingka", emoji: "🍰", desc: "Rice cake with salted egg" },
              { name: "Halo-Halo", emoji: "🍧", desc: "Shaved ice dessert" },
            ].map((p) => (
              <div className="col-6 col-md-3" key={p.name}>
                <div className="card border-0 shadow-sm h-100">
                  <div className="card-body py-4">
                    <div className="fs-1 mb-2">{p.emoji}</div>
                    <div className="fw-semibold small">{p.name}</div>
                    <div className="text-muted small">{p.desc}</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
          <Link href="/sam-store" className="btn btn-primary mt-4 px-4">
            See prices &amp; order
          </Link>
        </div>
      </section>

      {/* Footer */}
      <footer className="py-4 text-center text-muted small">
        <div className="container">
          <i className="bi bi-shop me-1"></i>Sam&apos;s Store · Cash on delivery · Serving your neighborhood
        </div>
      </footer>
    </div>
  );
}