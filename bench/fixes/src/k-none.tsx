// (k) No guard on submit: every click on Create sends a POST.

import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { DEFAULT_TITLE, TicketView, getTickets, postTicket, type Ticket } from "./shared/ticket-view.js";

function App() {
  const [tickets, setTickets] = useState<Ticket[]>();
  const [title, setTitle] = useState(DEFAULT_TITLE);
  const [created, setCreated] = useState<Ticket | null>(null);
  const [error, setError] = useState(false);

  const load = () => getTickets().then(setTickets, () => {});
  useEffect(() => {
    load();
  }, []);

  async function submit() {
    try {
      setCreated(await postTicket(title));
      setError(false);
      load();
    } catch {
      setError(true);
    }
  }

  return <TicketView tickets={tickets} title={title} onTitle={setTitle} onSubmit={submit} pending={false} created={created} error={error} />;
}

createRoot(document.getElementById("app")!).render(<App />);
