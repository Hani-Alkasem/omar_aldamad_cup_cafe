import type { RackDevice } from '@itam/shared';
import { DemoRack } from './DemoRack';

export const metadata = { title: 'Demo rack' };

/** Static fixture so the component can be reviewed without the API running. */
const devices: RackDevice[] = [
  { id: 'd1', name: 'core-sw-01', type: 'switch', status: 'active', model: 'Arista 7050SX3-48YC8', startU: 42, sizeU: 1, face: 'front', depth: 'full', powerW: 340, tempC: 27, ports: 56 },
  { id: 'd2', name: 'core-sw-02', type: 'switch', status: 'active', model: 'Arista 7050SX3-48YC8', startU: 41, sizeU: 1, face: 'front', depth: 'full', powerW: 330, tempC: 27, ports: 56 },
  { id: 'd3', name: 'patch-a01-f', type: 'patch_panel', status: 'active', model: 'Panduit CP48BLY', startU: 40, sizeU: 1, face: 'front', depth: 'half', powerW: 0, ports: 48 },
  { id: 'd4', name: 'patch-a01-r', type: 'patch_panel', status: 'active', model: 'Panduit CP48BLY', startU: 40, sizeU: 1, face: 'rear', depth: 'half', powerW: 0, ports: 48 },
  { id: 'd5', name: 'fw-edge-01', type: 'firewall', status: 'active', model: 'Palo Alto PA-3410', startU: 37, sizeU: 1, face: 'front', depth: 'full', powerW: 240, tempC: 31, ports: 16 },
  { id: 'd6', name: 'esx-01', type: 'physical_server', status: 'active', model: 'Dell PowerEdge R760', startU: 30, sizeU: 2, face: 'front', depth: 'full', powerW: 610, tempC: 24, ports: 4 },
  { id: 'd7', name: 'esx-02', type: 'physical_server', status: 'active', model: 'Dell PowerEdge R760', startU: 28, sizeU: 2, face: 'front', depth: 'full', powerW: 640, tempC: 25, ports: 4 },
  { id: 'd8', name: 'esx-03', type: 'physical_server', status: 'maintenance', model: 'Dell PowerEdge R760', startU: 26, sizeU: 2, face: 'front', depth: 'full', powerW: 0, ports: 4 },
  { id: 'd9', name: 'db-01', type: 'physical_server', status: 'active', model: 'Dell PowerEdge R760', startU: 22, sizeU: 2, face: 'front', depth: 'full', powerW: 720, tempC: 26, ports: 4 },
  { id: 'd10', name: 'backup-01', type: 'physical_server', status: 'planned', model: 'HPE ProLiant DL380 Gen11', startU: 18, sizeU: 2, face: 'front', depth: 'full', powerW: null, ports: 4 },
  { id: 'd11', name: 'nas-01', type: 'storage_array', status: 'active', model: 'NetApp AFF A250', startU: 10, sizeU: 2, face: 'front', depth: 'full', powerW: 880, tempC: 29, ports: 8 },
  { id: 'd12', name: 'ups-01', type: 'ups', status: 'active', model: 'APC SRT3000RMXLI', startU: 1, sizeU: 3, face: 'front', depth: 'full', powerW: 120, tempC: 30, ports: 1 },
  { id: 'd13', name: 'pdu-a01-l', type: 'pdu', status: 'active', model: 'APC AP8881', startU: null, sizeU: 1, face: null, depth: 'zero_u', powerW: 0 },
];

export default function DemoPage() {
  return <DemoRack rack={{ id: 'demo', name: 'A01 (demo)', heightU: 42, room: 'Hall 1', row: 'Row A' }} devices={devices} />;
}
