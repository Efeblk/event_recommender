// The request route authenticates first. Collection now runs only through the
// durable collector, preserving pagination, checkpoints and explicit AI budgets.
export async function POST(_request: Request) {
  return Response.json(
    { error: 'Use the collector import and checkpoint pipeline' },
    { status: 410 },
  );
}
