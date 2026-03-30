import { getSharedIndexStub, getUserControlStub } from "./auth";
import { log } from "./logger";
import type { Env } from "./types";

interface HealthReport {
  timestamp: string;
  staleSessionsFixed: number;
  errorSummary: { message: string; count: number }[];
  userCount: number;
  recommendations: string[];
}

export async function runHealthCheck(env: Env, ctx: ExecutionContext): Promise<HealthReport> {
  const report: HealthReport = {
    timestamp: new Date().toISOString(),
    staleSessionsFixed: 0,
    errorSummary: [],
    userCount: 0,
    recommendations: [],
  };

  const sharedStub = getSharedIndexStub(env);

  // 1. Fix stale sessions: query all users, check for sessions stuck in "running"
  try {
    const usersResp = await sharedStub.fetch("https://shared-index/users");
    const { users } = (await usersResp.json()) as { users: { email: string }[] };
    report.userCount = users.length;

    for (const user of users) {
      const ucStub = getUserControlStub(env, user.email);
      const sessResp = await ucStub.fetch("https://user-control/sessions");
      const { sessions } = (await sessResp.json()) as {
        sessions: { id: string; status: string }[];
      };

      for (const session of sessions) {
        if (session.status === "running") {
          // Poke the CodingAgent — readSessionDetails will auto-reconcile
          try {
            const agentId = env.CODING_AGENT.idFromName(session.id);
            const agentStub = env.CODING_AGENT.get(agentId);
            const stateResp = await agentStub.fetch(
              `https://coding-agent/?sessionId=${encodeURIComponent(session.id)}`,
            );
            const state = (await stateResp.json()) as { status: string };
            if (state.status !== "running") {
              report.staleSessionsFixed++;
              log("info", "Health check: auto-fixed stale session", {
                sessionId: session.id,
                email: user.email,
              });
            }
          } catch {
            // Session DO may not exist, that's fine
          }
        }
      }
    }
  } catch (e) {
    log("error", "Health check: failed to check stale sessions", {
      error: e instanceof Error ? e.message : String(e),
    });
  }

  // 2. Error summary from last 24 hours
  try {
    const errResp = await sharedStub.fetch("https://shared-index/errors/summary");
    const { groups } = (await errResp.json()) as {
      groups: { message: string; count: number }[];
    };
    report.errorSummary = groups.slice(0, 10);

    if (groups.length > 0) {
      const totalErrors = groups.reduce((sum, g) => sum + g.count, 0);
      if (totalErrors > 50) {
        report.recommendations.push(
          `High error rate: ${totalErrors} errors in last 24h across ${groups.length} unique messages`,
        );
      }
      // Flag the top error if it has > 10 occurrences
      if (groups[0] && groups[0].count > 10) {
        report.recommendations.push(
          `Top error (${groups[0].count}x): ${groups[0].message.slice(0, 100)}`,
        );
      }
    }
  } catch (e) {
    log("error", "Health check: failed to get error summary", {
      error: e instanceof Error ? e.message : String(e),
    });
  }

  // 3. Log the report
  log("info", "Health check complete", {
    staleSessionsFixed: report.staleSessionsFixed,
    errorCount: report.errorSummary.reduce((s, g) => s + g.count, 0),
    userCount: report.userCount,
    recommendations: report.recommendations,
  });

  return report;
}
