// (n) TanStack Query useMutation: the button is disabled while `isPending`; on success the tickets query is
// invalidated. Library defaults.

import { QueryClient, QueryClientProvider, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { DEFAULT_TITLE, TicketView, getTickets, postTicket } from "./shared/ticket-view.js";

const queryClient = new QueryClient();

function App() {
  const qc = useQueryClient();
  const [title, setTitle] = useState(DEFAULT_TITLE);
  const tickets = useQuery({ queryKey: ["tickets"], queryFn: getTickets });
  const create = useMutation({
    mutationFn: (t: string) => postTicket(t),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tickets"] }),
  });

  return (
    <TicketView
      tickets={tickets.data}
      title={title}
      onTitle={setTitle}
      onSubmit={() => create.mutate(title)}
      pending={create.isPending}
      created={create.data}
      error={create.isError}
    />
  );
}

createRoot(document.getElementById("app")!).render(
  <QueryClientProvider client={queryClient}>
    <App />
  </QueryClientProvider>,
);
