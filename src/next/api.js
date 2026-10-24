import axios from "axios";

let configured = false;

/**
 * Sends the CSRF token the server put in the page with every request, and reloads once if the server was
 * restarted while the page was open (it issues a new token at each start, and the old one is refused).
 */
export function setupApi() {
  if (configured) {
    return;
  }
  configured = true;

  axios.interceptors.response.use(undefined, (error) => {
    const body = error?.response?.data;
    if (error?.response?.status === 401 && typeof body === "string" && body.includes("CSRF token")) {
      const last = Number(sessionStorage.getItem("csrfReloadAt") || 0);
      if (Date.now() - last > 15000) {
        sessionStorage.setItem("csrfReloadAt", String(Date.now()));
        window.location.reload();
      }
    }
    // a page that needs the repository has nothing to show without one
    if (
      error?.response?.data?.code === "NOT_CONNECTED" &&
      !/^\/(repo|preferences|about)/.test(window.location.pathname)
    ) {
      window.location.replace("/repo");
    }
    return Promise.reject(error);
  });

  const tok = document.head.querySelector('meta[name="kopia-csrf-token"]');
  axios.defaults.headers.common["X-Kopia-Csrf-Token"] = tok && tok.content ? tok.content : "-";
}

/** The most useful text of a failed request. */
export function errorMessage(e) {
  const data = e?.response?.data;
  if (data && typeof data === "object") {
    return data.message || data.error || e.message || "unknown error";
  }
  if (typeof data === "string" && data.trim() && data.length < 300) {
    return data.trim();
  }
  return e?.message || "unknown error";
}

export const api = axios;
