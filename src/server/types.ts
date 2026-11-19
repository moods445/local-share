export interface PeerInfo {
  device: string;
  nickname: string;
  host: string;
  port: number;
}

export interface SelfInfo {
  device: string;
  nickname: string;
  port: number;
}

export interface Announce {
  t: 'hello';
  device: string;
  nickname: string;
  port: number;
}
