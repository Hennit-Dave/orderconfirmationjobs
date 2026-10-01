import { prisma } from '@/lib/prisma';

// Always render fresh from the DB — this page has no meaning as a static
// build artifact, and `next build` shouldn't need a live DB to prerender it.
export const dynamic = 'force-dynamic';

export default async function DeadLettersPage() {
  const deadJobs = await prisma.job.findMany({
    where: { status: 'dead' },
    orderBy: { updatedAt: 'desc' },
  });

  return (
    <main>
      <style>{`
        table { border-collapse: collapse; width: 100%; }
        th, td { border: 1px solid #999; padding: 8px; text-align: left; vertical-align: top; }
        pre { margin: 0; white-space: pre-wrap; word-break: break-word; }
        button { padding: 4px 12px; }
      `}</style>
      <h1>Dead Letters</h1>
      <p>{deadJobs.length} dead job{deadJobs.length === 1 ? '' : 's'}</p>

      {deadJobs.length === 0 ? (
        <p>No dead jobs.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Payload</th>
              <th>Attempts</th>
              <th>Last Error</th>
              <th>Retry</th>
            </tr>
          </thead>
          <tbody>
            {deadJobs.map((job) => (
              <tr key={job.id}>
                <td>{job.id}</td>
                <td>
                  <pre>{JSON.stringify(job.payload, null, 2)}</pre>
                </td>
                <td>
                  {job.attempts} / {job.maxAttempts}
                </td>
                <td>{job.lastError}</td>
                <td>
                  <form action={`/api/jobs/${job.id}/retry`} method="POST">
                    <button type="submit">Retry</buton>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
