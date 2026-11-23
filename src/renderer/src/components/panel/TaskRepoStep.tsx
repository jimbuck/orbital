import type { JSX } from 'react'
import { Layers } from 'lucide-react'
import type { Project, Repo, Task } from '@shared/types'
import { projectRepos, taskLaneKey, PROJECT_LANE } from '@renderer/lib/taskScope'
import { MenuItem } from '../rail/menu'
import { MENU_TITLE } from '../rail/menuSteps'
import { repoGlyph } from './TaskMeta'

/**
 * The card menu's Repo step: file a task under one of its project's repos,
 * or under none. Swaps in place of the menu's items, like the rail's steps.
 * The current choice is shown but disabled. A stale tag reads as none.
 */
export default function TaskRepoStep({
  task,
  project,
  repos,
  onDone
}: {
  task: Task
  project: Project
  repos: Repo[]
  onDone: () => void
}): JSX.Element {
  const current = taskLaneKey(task, project)
  const pick = (repoId: string | null): void => {
    void window.orbital.updateTask(task.id, { repoId })
    onDone()
  }
  return (
    <>
      <div className={MENU_TITLE}>Repo for #{task.seq}</div>
      <MenuItem
        icon={<Layers size={13} strokeWidth={1.5} />}
        label="No repo"
        hint={current === PROJECT_LANE ? 'current' : 'whole project'}
        disabled={current === PROJECT_LANE}
        onClick={() => pick(null)}
      />
      <div className="my-1 h-px bg-soft" />
      <div className="max-h-[260px] overflow-y-auto">
        {projectRepos(project, repos).map((r) => {
          const Glyph = repoGlyph(r, project.homeRepoId)
          return (
            <MenuItem
              key={r.id}
              icon={<Glyph size={13} strokeWidth={1.5} />}
              label={r.name}
              hint={current === r.id ? 'current' : undefined}
              disabled={current === r.id}
              onClick={() => pick(r.id)}
            />
          )
        })}
      </div>
    </>
  )
}
