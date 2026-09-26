'use strict'

// 작은 파일들을 폴더 단위로 묶는다. 폴더 합계가 limit 이하면 폴더 하나가 한 묶음,
// 넘으면 하위 폴더로 쪼갠다. 같은 폴더 내용이면 매번 같은 묶음이 나오므로
// 바뀌지 않은 묶음은 이전 릴리스 것을 그대로 재사용할 수 있다.

function groupFiles (files, limit) {
  const groups = []
  const total = items => items.reduce((n, f) => n + f.size, 0)

  function split (prefix, items) {
    if (total(items) <= limit || items.length === 1) {
      groups.push({ id: prefix || '.', files: items })
      return
    }
    const loose = []
    const children = new Map()
    for (const f of items) {
      const rest = prefix ? f.path.slice(prefix.length + 1) : f.path
      const slash = rest.indexOf('/')
      if (slash === -1) {
        loose.push(f)
      } else {
        const child = (prefix ? prefix + '/' : '') + rest.slice(0, slash)
        if (!children.has(child)) children.set(child, [])
        children.get(child).push(f)
      }
    }
    for (const child of [...children.keys()].sort()) split(child, children.get(child))

    // 폴더 바로 아래 파일들: limit 단위로 순서대로 자른다
    let chunk = []
    let size = 0
    let n = 0
    const flush = () => {
      if (!chunk.length) return
      groups.push({ id: `${prefix || '.'}/*${n ? '#' + (n + 1) : ''}`, files: chunk })
      n++
      chunk = []
      size = 0
    }
    for (const f of loose.sort((a, b) => a.path < b.path ? -1 : 1)) {
      if (size + f.size > limit) flush()
      chunk.push(f)
      size += f.size
    }
    flush()
  }

  split('', [...files].sort((a, b) => a.path < b.path ? -1 : 1))
  return groups
}

module.exports = { groupFiles }
