// 陪伴层会话归类：把外部会话映射到默认命名空间。
// core 侧 syncSessions({ classifySession }) 注入；本项目默认读 CM_LIFE_* 环境变量。
export function classifySession(sessionId, workspace) {
  const hard = (process.env.CM_LIFE_SESSIONS || '').split(',').map(s=>s.trim()).filter(Boolean);
  const ws = (process.env.CM_LIFE_WORKSPACES || '').split(',').map(s=>s.trim()).filter(Boolean);
  if (hard.some(p => sessionId === p || sessionId.startsWith(p) || sessionId.includes(p))) return 'life';
  if (ws.some(p => workspace && (workspace === p || workspace.includes(p)))) return 'life';
  return 'shared';
}
