import type { DictPartial } from "./zh";

/**
 * 英文字典（英文版最后补齐；缺失 key 由 getDict 回落到中文）。
 * TODO(S10): 逐条补齐英文文案。
 */
export const en: DictPartial = {
  anchorNav: {
    performance: "Performance",
    opportunity: "Worth it?",
    traffic: "Traffic",
    business: "The business",
    playbook: "How to build it",
    ideas: "What you can make",
  },
  sections: {
    performance: {
      no: "01",
      title: "Performance",
      desc: "How big it is right now, and how fast it is growing.",
    },
    opportunity: {
      no: "02",
      title: "Worth doing?",
      desc: "At a glance: is this category still open, and worth entering?",
    },
    traffic: {
      no: "03",
      title: "Traffic",
      desc: "Where its traffic comes from, who visits, and how it gets found — its traffic story.",
    },
    business: {
      no: "04",
      title: "The business",
      desc: "How it makes money and cold-starts; what to learn and what to avoid.",
    },
    playbook: {
      no: "05",
      title: "How to build it",
      desc: "What tech you need, at what cost and timeline.",
    },
    ideas: {
      no: "06",
      title: "What you can make",
      desc: "A few variant directions you could start right away.",
    },
  },
};
