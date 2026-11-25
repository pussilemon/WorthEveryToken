import fs from "node:fs";
import path from "node:path";
import type { Backlog } from "../config/schema.js";

export interface ReportData {
  auditBranch: string;
  durationMs: number;
  stopReason: string;
  backlog: Backlog;
  totalCostUsd?: number;
}

export class Reporter {
  public static generateMarkdown(data: ReportData): string {
    const { auditBranch, durationMs, stopReason, backlog, totalCostUsd } = data;
    const durationMin = (durationMs / 60000).toFixed(1);

    const completed = backlog.tasks.filter((t) => t.status === "completed");
    const failed = backlog.tasks.filter((t) => t.status === "failed");
    const skipped = backlog.tasks.filter((t) => t.status === "skipped");
    const pending = backlog.tasks.filter((t) => t.status === "pending" || t.status === "in_progress");

    const providerCounts: Record<string, number> = {};
    for (const t of completed) {
      const agent = t.metrics?.agent_used ?? t.assigned_agent ?? "unknown";
      providerCounts[agent] = (providerCounts[agent] ?? 0) + 1;
    }
    const fallbackCount = backlog.tasks.filter((t) => t.metrics?.fallback_triggered).length;

    let md = `# WorthEveryToken (wet) Autonomous Audit Execution Report\n\n`;
    md += `## 1. Executive Summary\n\n`;
    md += `- **Audit Branch:** \`${auditBranch}\`\n`;
    md += `- **Total Duration:** ${durationMin} minutes\n`;
    md += `- **Termination Reason:** **${stopReason}**\n`;
    md += `- **Completed Tasks:** ${completed.length} / ${backlog.tasks.length}\n`;
    md += `- **Failed Tasks:** ${failed.length}\n`;
    md += `- **Skipped Tasks:** ${skipped.length}\n`;
    if (totalCostUsd !== undefined) {
      md += `- **Estimated Cost:** $${totalCostUsd.toFixed(2)} USD\n`;
    }
    md += `\n---\n\n`;

    md += `## 2. Integrated Commits (Ready for PR)\n\n`;
    if (completed.length === 0) {
      md += `*No tasks were completed in this session.*\n\n`;
    } else {
      md += `| SHA | Task ID | Agent | Summary | Tests Added |\n`;
      md += `| :--- | :--- | :--- | :--- | :---: |\n`;
      for (const t of completed) {
        const sha = t.commit_sha ? t.commit_sha.slice(0, 7) : "N/A";
        const agent = t.metrics?.agent_used ?? t.assigned_agent;
        const summary = t.digest?.summary ?? t.title;
        const tests = t.digest?.tests_added ?? 0;
        md += `| \`${sha}\` | \`${t.id}\` | ${agent} | ${summary} | +${tests} |\n`;
      }
      md += `\n`;
    }

    md += `## 3. Failed or Blocked Tasks (Monday Morning Review)\n\n`;
    const issues = [...failed, ...skipped];
    if (issues.length === 0) {
      md += `*None. All scheduled tasks passed successfully.*\n\n`;
    } else {
      md += `| Task ID | Status | Title | Reason |\n`;
      md += `| :--- | :--- | :--- | :--- |\n`;
      for (const t of issues) {
        md += `| \`${t.id}\` | **${t.status.toUpperCase()}** | ${t.title} | ${t.failure_reason ?? "Unknown"} |\n`;
      }
      md += `\n`;
    }

    md += `## 4. Telemetry & Routing Metrics\n\n`;
    const entries = Object.entries(providerCounts);
    if (entries.length === 0) {
      md += `- **Provider Executions:** None in this wave\n`;
    } else {
      for (const [provider, count] of entries) {
        md += `- **${provider} Executions:** ${count}\n`;
      }
    }
    md += `- **Fallback Triggers:** ${fallbackCount}\n`;
    md += `- **Pending Tasks Remaining in Backlog:** ${pending.length}\n\n`;

    return md;
  }

  public static saveReport(data: ReportData, outputDir = ".wet"): string {
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const filename = `REPORT-${dateStr}.md`;
    const fullPath = path.join(outputDir, filename);

    fs.mkdirSync(outputDir, { recursive: true });
    const content = this.generateMarkdown(data);
    fs.writeFileSync(fullPath, content, "utf-8");
    return fullPath;
  }
}
