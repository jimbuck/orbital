// @ts-check
import { defineConfig } from 'astro/config'
import starlight from '@astrojs/starlight'

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
            { label: 'Projects, Worktrees & tabs', slug: 'concepts/projects-and-worktrees' },
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
            { label: 'Dev servers', slug: 'guides/dev-servers' }
          ]
        },
        {
          label: 'Reference',
          items: [
            { label: 'The orbital CLI', slug: 'reference/cli' },
            { label: 'Settings', slug: 'reference/settings' },
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
