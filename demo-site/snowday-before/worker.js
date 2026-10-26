// The snow day site as a Worker, like the live snowday-predictor: static files from the ASSETS binding, plus the demo's
// three endpoints (functions/api/: the board search, alerts, road conditions), the same handlers Pages would run.
import { onRequest as boards } from "./functions/api/boards.js";
import { onRequest as alerts } from "./functions/api/alerts.js";
import { onRequest as roads } from "./functions/api/roads.js";

const API = { "/api/boards": boards, "/api/alerts": alerts, "/api/roads": roads };

export default {
  async fetch(request, env) {
    const handler = API[new URL(request.url).pathname];
    if (handler) return handler({ request, env });
    return env.ASSETS.fetch(request);
  },
};
