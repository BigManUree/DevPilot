import React from 'react';
import Dashboard from './Dashboard';

/** 独立项目管理路由；与工作台共享同一套真实项目状态、操作和详情实现。 */
export default function Projects({ selectedId, onSelect }: { selectedId: string | null; onSelect: (id: string | null) => void }) {
  return <Dashboard variant="projects" selectedId={selectedId} onSelect={onSelect}/>;
}
