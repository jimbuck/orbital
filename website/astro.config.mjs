// @ts-check
import { defineConfig } from 'astro/config'
import starlight from '@astrojs/starlight'
import starlightLlmsTxt from 'starlight-llms-txt'

// https://astro.build/config
export default defineConfig({
  // Adjust when the production domain is decided (also used for sitemap/canonical URLs).
  site: 'https://jimbuck.github.io',
  base: '/orbital',
  integrations: [
    starlight({
      title: 'Orbital',
      description:
        'A native Windows cockpit for running many interactive coding agents side by side — each in its own git worktree, with live status, tasks, and a full git panel.',
      plugins: [
        starlightLlmsTxt({
          projectName: 'Orbital',
          details: [
            'Orbital is a Windows desktop app (Electron). It spawns the real interactive agent CLIs (Claude Code, Codex, Cursor) in real terminals; it does not wrap them or call model APIs.',
            '',
            'If you are an agent running inside an Orbital terminal (`ORBITAL_WORKTREE_ID` is set), the pages under "For agents" and the CLI reference are the ones you need: the `orbital` CLI reports your status, files and progresses tasks, and registers dev servers.'
          ].join('\n'),
          customSets: [
            {
              label: 'For agents',
              description: 'the orbital CLI and the conventions an agent running inside Orbital should follow',
              paths: ['agents/**', 'reference/cli']
            }
          ],
          promote: ['agents/**', 'reference/cli'],
          exclude: ['index']
        })
      ],
      logo: { src: './src/assets/orbital.svg', alt: 'Orbital' },
      favicon: '/favicon.svg',
      social: { github: 'https://github.com/jimbuck/orbital' },
      editLink: { baseUrl: 'https://github.com/jimbuck/orbital/edit/main/website/' },
      components: {
        ThemeProvider: './src/components/ThemeProvider.astro',
        ThemeSelect: './src/components/ThemeSelect.astro'
      },
      expressiveCode: {
        themes: ['github-dark-default']
      },
      sidebar: [
        {
          label: 'Getting started',
          items: [
            { label: 'What is Orbital?', slug: 'getting-started/what-is-orbital' },
            { label: 'Installation', slug: 'getting-started/installation' },
            { label: 'Quick start', slug: 'getting-started/quick-start' }
          ]
        },
        {
          label: 'Concepts',
          items: [
            { label: 'Workspaces', slug: 'concepts/workspaces' },
            { label: 'Projects, worktrees & tabs', slug: 'concepts/projects-and-worktrees' },
            { label: 'Status & alerts', slug: 'concepts/status-and-alerts' }
          ]
        },
        {
          label: 'Guides',
          items: [
            { label: 'Running agents', slug: 'guides/running-agents' },
            { label: 'Tasks', slug: 'guides/tasks' },
            { label: 'The git panel', slug: 'guides/git-panel' },
            { label: 'The editor', slug: 'guides/editor' },
            { label: 'Command palette & search', slug: 'guides/command-palette' },
            { label: 'Dev servers', slug: 'guides/dev-servers' },
            { label: 'Themes & appearance', slug: 'guides/appearance' }
          ]
        },
        {
          label: 'For agents',
          items: [
            { label: 'Working inside Orbital', slug: 'agents/overview' },
            { label: 'Wiring up your agent', slug: 'agents/integration' },
            { label: 'The orbital skill', slug: 'agents/skill' },
            { label: 'llms.txt', slug: 'agents/llms-txt' }
          ]
        },
        {
          label: 'Reference',
          items: [
            { label: 'The orbital CLI', slug: 'reference/cli' },
            { label: 'Settings', slug: 'reference/settings' },
            { label: 'Keyboard shortcuts', slug: 'reference/keyboard-shortcuts' },
            { label: 'Troubleshooting', slug: 'reference/troubleshooting' }
          ]
        }
      ],
      customCss: [
        '@fontsource-variable/archivo',
        '@fontsource-variable/hanken-grotesk',
        '@fontsource/jetbrains-mono/400.css',
        '@fontsource/jetbrains-mono/700.css',
        './src/styles/custom.css'
      ]
    })
  ]
})
