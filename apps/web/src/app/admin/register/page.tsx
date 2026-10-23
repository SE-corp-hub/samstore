// Rice Ops M11: public owner sign-up is closed. The platform admin creates stores and
// owners; owners add their own staff (Team). The old form is in git history
// (AdminRegister.tsx) for the day sign-up is reopened (ALLOW_OWNER_SIGNUP=true on the API).

export default function RegisterPage() {
  return (
    <div className="admin-login">
      <div className="container d-flex align-items-center justify-content-center" style={{ minHeight: "100vh" }}>
        <div className="card shadow-sm p-4 text-center" style={{ width: "100%", maxWidth: 420 }}>
          <i className="bi bi-lock fs-1 text-secondary" aria-hidden="true"></i>
          <h1 className="h4 mt-2">Sign-up is closed</h1>
          <p className="mb-3">The store owner will add you. Ask them for your login.</p>
          <a className="btn btn-primary" href="/admin/login">Back to login</a>
        </div>
      </div>
    </div>
  );
}
