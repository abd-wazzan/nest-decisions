import { defineConfig } from 'vitepress';

// Project site: https://abd-wazzan.github.io/nest-decisions/  -> base '/nest-decisions/'
// Organization or custom-domain root:                           -> set DOCS_BASE=/
const base = process.env.DOCS_BASE ?? '/nest-decisions/';

export default defineConfig({
  title: 'nest-decisions',
  description:
    'Confidence-gated actions with shadow rollout for NestJS: typed questions, a pure policy, allow/review/block gates.',
  base,
  lang: 'en-US',
  cleanUrls: true,
  lastUpdated: false,
  head: [['link', { rel: 'icon', href: `${base}favicon.svg` }]],
  themeConfig: {
    logo: { src: '/favicon.svg', alt: 'nest-decisions' },
    nav: [
      { text: 'Guide', link: '/quickstart' },
      { text: 'Recipes', link: '/recipes' },
      { text: 'Production', link: '/production-checklist' },
    ],
    sidebar: [
      {
        text: 'Start here',
        items: [
          { text: 'Why decisions', link: '/why-decisions' },
          { text: 'Quickstart', link: '/quickstart' },
          { text: 'Concepts', link: '/concepts' },
        ],
      },
      {
        text: 'Use it',
        items: [
          { text: 'Recipes', link: '/recipes' },
          { text: 'Calibration', link: '/calibration' },
          { text: 'Production adapters', link: '/adapters' },
          { text: 'Production checklist', link: '/production-checklist' },
        ],
      },
      {
        text: 'Extend it',
        items: [{ text: 'Writing a provider', link: '/writing-a-provider' }],
      },
      {
        text: 'Maintainers',
        items: [
          { text: 'Trying it with real teams', link: '/testing-with-users' },
          { text: 'Releasing', link: '/releasing' },
        ],
      },
    ],
    socialLinks: [{ icon: 'github', link: 'https://github.com/abd-wazzan/nest-decisions' }],
    search: { provider: 'local' },
    editLink: {
      pattern: 'https://github.com/abd-wazzan/nest-decisions/edit/main/docs/:path',
      text: 'Edit this page on GitHub',
    },
    footer: {
      message: 'Released under the MIT License. Pre-alpha: the API can change.',
    },
  },
});
