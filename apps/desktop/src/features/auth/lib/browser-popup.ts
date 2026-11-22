const parameter = "paperkit_login";
const channelName = (id: string) => "paperkit-login-" + id;

// Run before the application (and its auth SDK) boots in the callback window.
export function finishBrowserPopup() {
  const url = new URL(window.location.href);
  const id = url.searchParams.get(parameter);
  if (!id || !/^[\da-f-]{36}$/i.test(id)) return false;
  const channel = new BroadcastChannel(channelName(id));
  const failure =
    url.searchParams.get("error") ?? new URLSearchParams(url.hash.slice(1)).get("error");
  const close = () => {
    channel.close();
    window.close();
  };
  channel.onmessage = ({ data }) => {
    if (data?.done === true) close();
  };
  channel.postMessage({ code: url.searchParams.get("code"), error: failure });
  history.replaceState(null, "", url.pathname);
  window.setTimeout(close, 20_000);
  return true;
}

export function openBrowserPopup() {
  const id = crypto.randomUUID();
  const popup = window.open("about:blank", channelName(id), "popup,width=540,height=740");
  if (!popup) throw new Error("popup_blocked");
  popup.opener = null;
  const channel = new BroadcastChannel(channelName(id));
  const redirect = new URL("/", window.location.origin);
  redirect.searchParams.set(parameter, id);
  const cancel = new AbortController();
  return {
    redirectUrl: redirect.href,
    async authorize(url: string) {
      if (cancel.signal.aborted || popup.closed) throw "login_cancelled";
      return new Promise<string>((resolve, reject) => {
        const timer = window.setTimeout(() => reject(new Error("login_timeout")), 180_000);
        const poll = window.setInterval(() => {
          if (popup.closed) reject("login_cancelled");
        }, 500);
        const clear = () => {
          window.clearInterval(poll);
          window.clearTimeout(timer);
        };
        cancel.signal.addEventListener(
          "abort",
          () => {
            clear();
            reject("login_cancelled");
          },
          { once: true },
        );
        channel.onmessage = ({ data }) => {
          clear();
          if (typeof data?.code === "string" && data.code && !data.error) resolve(data.code);
          else
            reject(data?.error === "access_denied" ? "login_cancelled" : new Error("login_failed"));
        };
        popup.location.replace(url);
      });
    },
    close() {
      if (cancel.signal.aborted) return;
      cancel.abort();
      channel.postMessage({ done: true });
      channel.close();
      popup.close();
    },
  };
}
