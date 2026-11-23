import type { JSX } from 'react'
import Repo from './Repo'
import ProjectGroup from './ProjectGroup'
import type { DropTarget, ProjectRow } from './folders'

/**
 * One project in the rail: a plain repo row when it is flat (one repo, no
 * home), else a group. `dropTarget` is the Rail's current one; each kind picks
 * out the part that concerns it.
 */
export default function ProjectItem({
  row,
  dropTarget
}: {
  row: ProjectRow
  dropTarget: DropTarget | null
}): JSX.Element {
  const joinTarget = dropTarget?.kind === 'join' && dropTarget.projectId === row.id
  if (row.kind === 'flat') return <Repo variant="flat" repo={row.repo} project={row.project} joinTarget={joinTarget} />
  const repoSlot = dropTarget?.kind === 'repoSlot' && dropTarget.projectId === row.id ? dropTarget.index : null
  return <ProjectGroup row={row} joinTarget={joinTarget} repoSlot={repoSlot} />
}
