# Router

The current router is an offline lexical baseline. It tokenizes the user task and catalog descriptions, scores exact token overlap normalized by catalog size, and returns one active agent, up to three skills, and at most 15 enabled tools. The response includes a bounded candidate list, confidence estimate, and backend label. It never executes the selected tools.

Use the dashboard's Router page for a preview. The API is `POST /api/route` with `{ "task": "..." }` after dashboard authentication.

BM25, embeddings, LLM selection, fine-tuned serving, two-stage categories, training data generation, parity fixtures, and evaluation thresholds from the build prompt are not implemented. Scores are a simple lexical heuristic and should not be interpreted as calibrated confidence.
