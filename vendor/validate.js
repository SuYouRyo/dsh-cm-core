// 🔴 红线校验：拒绝人格诊断，拒绝没有来源的条目。
//
// 对应决策记录第十一节。这条不是「建议」，是硬门禁：
// 凡是带人格诊断色彩的条目，addImpression 之前就该被拦下来。
//
// 为什么用确定性规则而不是让模型判断：
//   模型会心软，会觉得「这句挺准的，留着吧」。而这条红线恰恰要求不留。

/** 人格诊断类词：出现即拒。 */
const DIAGNOSIS_PATTERNS = [
  // 依恋类型
  /依恋型|回避型|焦虑型|恐惧[-－]?回避|混乱型依恋|安全型依恋|依赖性人格/,
  // 防御机制 / 精神动力学
  /防御机制|情感隔离|理智化|反向形成|投射性认同|假性自体|假性独立|强迫性照顾|强迫性自我依赖|去激活策略|心智化|自体客体|客体关系/,
  // 临床标签
  /人格障碍|边缘型|自恋型|抑郁|焦虑症|创伤后应激|C-?PTSD|微创伤|躯体化|心理疾病|精神问题/,
  // 依恋创伤
  /认识论信任|原生家庭创伤|情感忽视/,
  // 行为模式命名（这是报告的口吻，不是朋友的口吻）
  /社交策略|社交毒点|高危模式|行为模式是|这个人格/,
  // 「你是谁」式定性
  /你是[一个]?[^，。]{0,12}的人/,
  /他是[一个]?[^，。]{0,12}的人/,
  /用户是[一个]?[^，。]{0,12}的人/
];

/** 允许的句式：行为约束。带这些词的条目通常是「怎么对待他」，放行。 */
const BEHAVIOR_MARKERS = [
  /不要|别|避免|不要问|不用|先停|等一下|降速/,
  /他说|他说过|他难受|他会|他不太|他常|他喜欢|他讨厌|他习惯/
];

/**
 * 校验一条印象。
 * @returns {{ok:boolean, errors:string[], warnings:string[]}}
 */
export function validateImpression({ text, source, tag, t: at } = {}) {
  const errors = [];
  const warnings = [];
  const t = String(text ?? '').trim();

  if (!t) errors.push('正文为空');
  if (t.length > 300) errors.push(`正文过长（${t.length} 字，上限 300）`);
  if (!source) errors.push('缺少 source（四态来源必填）');
  else if (!['user_said', 'inferred', 'imagined', 'told'].includes(source)) {
    errors.push(`source 非法：${source}`);
  }

  // 红线：人格诊断
  for (const re of DIAGNOSIS_PATTERNS) {
    if (re.test(t)) {
      errors.push(`🔴 触碰红线「人格诊断」：命中 ${re} —— 记忆里不允许出现对用户的人格判断`);
      break;
    }
  }

  // 自我评价式（"我是一个……的人"）也归入红线精神：那是判决，不是记忆
  if (/^我(是|属于)[^，。]{0,20}(的人|人格|性格)/.test(t)) {
    errors.push('🔴 这是自我评价，不是印象。改写成发生过的事。');
  }

  // 提醒类：没有时间的印象会变成设定。
  // 注意：记录里有 t（事件时间）就算有时间，不该因为正文里没写日期而报警。
  const hasTimeField = Number.isFinite(Number(at)) && Number(at) > 0;
  if (!hasTimeField && !/\d{1,4}[-/.月年]|\d+[点时]|今天|昨天|前天|上周|上个月|去年|之前|那次|当时/.test(t)) {
    warnings.push('没有时间线索：印象最好带时间，否则会像设定');
  }

  // 提醒类：既没行为标记也没时间，可能是纯判断
  if (!BEHAVIOR_MARKERS.some((re) => re.test(t)) && t.length < 8) {
    warnings.push('过短且不含行为信息，可能不足以指导行为');
  }

  // 第三方隐私
  if (/(他说|她说|他妈|他家和|她家)[^，。]{0,10}(隐私|秘密|病|离婚|出轨|住院|ICU|死)/.test(t)) {
    errors.push('🔴 疑似第三方隐私，第三方的事不进库');
  }

  return { ok: errors.length === 0, errors, warnings };
}

/** 给 CLI 用：把错误和提醒格式化成一段人话。 */
export function formatIssues({ errors, warnings }) {
  const lines = [];
  for (const e of errors) lines.push(`✗ ${e}`);
  for (const w of warnings) lines.push(`⚠ ${w}`);
  return lines.join('\n');
}
