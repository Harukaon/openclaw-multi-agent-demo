import type { GroupMember, Mention } from "./types.js";

function normalizeToken(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase()
    .replace(/[^a-z0-9_\-.]+/gi, "-")
    .replace(/^-+|-+$/g, "");
}

export function parseMentions(content: string, members: GroupMember[]): Mention[] {
  const aliases = new Map<string, GroupMember>();
  for (const member of members) {
    const aliasesForMember = new Set([
      member.memberId,
      member.displayName,
      member.displayName.replace(/\s+/g, ""),
      member.displayName.replace(/\s+/g, "-"),
    ]);
    for (const alias of aliasesForMember) {
      const normalized = normalizeToken(alias);
      if (normalized) aliases.set(normalized, member);
    }
  }

  const result: Mention[] = [];
  const seen = new Set<string>();
  for (const match of content.matchAll(/@([A-Za-z0-9][A-Za-z0-9_.-]{0,63})/g)) {
    const token = normalizeToken(match[1] ?? "");
    const matchedMembers = token === "all"
      ? members
      : (aliases.has(token) ? [aliases.get(token)!] : []);
    for (const member of matchedMembers) {
      const key = `${member.memberType}:${member.memberId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({
        type: member.memberType,
        id: member.memberId,
        displayName: member.displayName,
      });
    }
  }
  return result;
}

export function mentionStateFor(
  senderType: "human" | "agent",
  senderId: string,
  recipientAgentId: string,
  mentions: Mention[],
): "SELF" | "DIRECT" | "OTHER" | "NONE" {
  if (senderType === "agent" && senderId === recipientAgentId) return "SELF";
  if (mentions.some((mention) => mention.type === "agent" && mention.id === recipientAgentId)) {
    return "DIRECT";
  }
  return mentions.length > 0 ? "OTHER" : "NONE";
}
