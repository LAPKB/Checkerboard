import { useEffect, useRef, useState } from "react";
import { version } from "../package.json";
import history from "./version-history.json";

export const appVersion = version;

export function VersionHistoryButton() {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" className="version-button" aria-label={`Version ${appVersion}: view changes`} aria-haspopup="dialog" onClick={() => setOpen(true)}>v{appVersion}</button>
    {open && <VersionHistoryDialog close={() => setOpen(false)} />}
  </>;
}

export function VersionHistoryDialog({ close }: { close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return <dialog ref={dialog} className="version-history-dialog" aria-labelledby="version-history-title" onClose={close}
    onClick={(event) => { if (event.target === event.currentTarget) dialog.current?.close(); }}>
    <div className="version-history-panel">
      <header><div><h1 id="version-history-title">Version history</h1><p>Checkmate v{appVersion}</p></div>
        <button type="button" className="instructions-close-icon" aria-label="Close version history" autoFocus onClick={() => dialog.current?.close()}>×</button>
      </header>
      <div className="version-history-content">{history.map((entry) => <section key={entry.version}>
        <h2>Version {entry.version}{entry.version === appVersion && <small>Current</small>}</h2>
        <ul>{entry.changes.map((change) => <li key={change}>{change}</li>)}</ul>
      </section>)}</div>
      <footer><button type="button" className="primary-button" onClick={() => dialog.current?.close()}>Close</button></footer>
    </div>
  </dialog>;
}
