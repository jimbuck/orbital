import { describe, expect, it } from 'vitest'
import { baseName, nearestCommonDir, parentDir, projectRootFor } from './project-root'

describe('nearestCommonDir', () => {
  it('finds the deepest shared folder, keeping the first path spelling', () => {
    expect(nearestCommonDir(['C:\\Work\\Acme\\api', 'c:\\work\\acme\\web'])).toBe('C:\\Work\\Acme')
    expect(nearestCommonDir(['C:/src/a', 'C:/src/b/c'])).toBe('C:/src')
    expect(nearestCommonDir(['/home/me/a', '/home/me/b'])).toBe('/home/me')
  })

  it('treats either slash, and a trailing one, alike', () => {
    expect(nearestCommonDir(['C:\\src\\a\\', 'C:/src/b'])).toBe('C:\\src')
  })

  it('returns a repo path itself when the other repo is inside it', () => {
    expect(nearestCommonDir(['C:\\src\\app', 'C:\\src\\app\\plugins\\x'])).toBe('C:\\src\\app')
  })

  it('does not match a folder that only shares a prefix of its name', () => {
    expect(nearestCommonDir(['C:\\src\\app', 'C:\\src\\application'])).toBe('C:\\src')
  })

  it('offers nothing for different drives or only a root in common', () => {
    expect(nearestCommonDir(['C:\\a', 'D:\\a'])).toBeNull()
    expect(nearestCommonDir(['C:\\a', 'C:\\b'])).toBeNull()
    expect(nearestCommonDir(['/a', '/b'])).toBeNull()
    expect(nearestCommonDir([])).toBeNull()
  })
})

describe('projectRootFor', () => {
  it('uses the common folder, or the first repo parent when there is none', () => {
    expect(projectRootFor(['C:\\src\\a', 'C:\\src\\b'])).toBe('C:\\src')
    expect(projectRootFor(['C:\\src\\a', 'D:\\b'])).toBe('C:\\src')
  })
})

describe('parentDir and baseName', () => {
  it('walk one level up and name the last segment', () => {
    expect(parentDir('C:\\src\\a')).toBe('C:\\src')
    expect(parentDir('C:\\')).toBe('C:\\')
    expect(parentDir('/a')).toBe('/')
    expect(parentDir('C:\\a')).toBe('C:\\')
    expect(baseName('C:\\src\\acme')).toBe('acme')
    expect(baseName('C:/src/acme/')).toBe('acme')
  })
})
