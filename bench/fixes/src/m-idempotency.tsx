// (m) Idempotency key checked by the server: the form holds one key per submission intent (new when the title
// changes) and sends it in an Idempotency-Key header; the server creates one ticket per key and answers repeats with
// the same ticket. The button is not disabled.

import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { DEFAULT_TITLE, TicketView, getTickets, postTicket, type Ticket } from "./shared/ticket-view.js";

function App() {
  const [tickets, setTickets] = useState<Ticket[]>();
  const [title, setTitle] = useState(DEFAULT_TITLE);
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [created, setCreated] = useState<Ticket | null>(null);
  const [error, setError] = useState(false);

  const load = () => getTickets().then(setTickets, () => {});
  useEffect(() => {
    load();
  }, []);

  function onTitle(t: string) {
    setTitle(t);
    setKey(crypto.randomUUID());
  }

  async function submit() {
    try {
      setCreated(await postTicket(title, { "Idempotency-Key": key }));
      setError(false);
      load();
    } catch {
      setError(true);
    }
  }

  return <TicketView tickets={tickets} title={title} onTitle={onTitle} onSubmit={submit} pending={false} created={created} error={error} />;
}

createRoot(document.getElementById("app")!).render(<App />);
