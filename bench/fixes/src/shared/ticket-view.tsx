// The "new ticket" page's markup for the submit strategies: the open tickets (loaded on mount), a form with a
// prefilled title and a Create button (#create), and #created / #error after a submit.

export interface Ticket {
  id: number;
  title: string;
}

export const DEFAULT_TITLE = "Printer on floor 3 is jammed";

/** POST a new ticket; throws on an HTTP error. */
export async function postTicket(title: string, headers: Record<string, string> = {}): Promise<Ticket> {
  const r = await fetch("/api/tickets", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ title }),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return ((await r.json()) as { ticket: Ticket }).ticket;
}

export async function getTickets(): Promise<Ticket[]> {
  const r = await fetch("/api/tickets");
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return ((await r.json()) as { tickets: Ticket[] }).tickets;
}

export function TicketView(props: {
  tickets: Ticket[] | undefined;
  title: string;
  onTitle(t: string): void;
  onSubmit(): void;
  pending: boolean;
  created: Ticket | null | undefined;
  error: boolean;
}) {
  const { tickets, title, onTitle, onSubmit, pending, created, error } = props;
  return (
    <main>
      <h1>New ticket</h1>
      <p id="count" className="muted">{tickets ? `${tickets.length} open tickets` : "Loading tickets…"}</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
        }}
      >
        <input id="title" value={title} onChange={(e) => onTitle(e.target.value)} aria-label="Title" />
        <button id="create" type="submit" disabled={pending}>Create ticket</button>
      </form>
      {created ? <p id="created" data-id={created.id}>Created ticket #{created.id}</p> : null}
      {error ? <p id="error" role="alert">Could not create the ticket.</p> : null}
    </main>
  );
}
