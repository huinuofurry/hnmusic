#!/bin/bash
# 看看都有谁注册了、谁最近还在用（只读 db.json）
cd /opt/hnmusic || exit 1
node -e '
const d = require("/opt/hnmusic/data/db.json");
const now = Date.now();
const days = (t) => Math.floor((now - t) / 86400000);
const users = d.users || [];
const sessions = (d.sessions || []).filter((s) => s.expiresAt > now);
const byUser = new Map();
for (const s of sessions) {
  const cur = byUser.get(s.userId);
  if (!cur || s.expiresAt > cur.expiresAt) byUser.set(s.userId, s);
}
console.log("  注册用户 " + users.length + " 个：");
for (const u of users) {
  const s = byUser.get(u.id);
  const last = s ? (s.createdAt ? Math.floor((now - s.createdAt) / 86400000) + " 天前登录过" : "有活跃会话") : "没有活跃会话";
  console.log("    · " + (u.displayName || u.username) + "  (@" + u.username + ")" +
    "  角色=" + (u.role || "user") +
    "  注册=" + days(u.createdAt) + " 天前" +
    "  " + last);
}
const guests = Object.keys(d.queues || {}).filter((k) => k.startsWith("s:")).length;
console.log("  游客身份（s: 开头的队列）: " + guests + " 个");
console.log("  房间: " + (d.rooms || []).length + " 个   歌单: " + (d.playlists || []).length + " 个");
'
