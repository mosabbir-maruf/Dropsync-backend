export type WsInbound =
  | { type: 'create-room'; payload?: { name?: string; isPublic?: boolean; passwordProtected?: boolean; createdBy?: string; description?: string } }
  | { type: 'get-public-rooms' }
  | { type: 'join'; roomId?: string; userId?: string; displayName?: string; password?: string }
  | { type: 'signal'; roomId?: string; userId?: string; targetId?: string; signal?: unknown }
  | { type: 'chat-invite'; roomId?: string; userId?: string; targetId?: string }
  | { type: 'call'; roomId?: string; userId?: string; targetId?: string; callType?: 'audio' | 'video' | string }
  | { type: 'call-accepted'; roomId?: string; userId?: string; targetId?: string; from?: string }
  | { type: 'call-missed'; roomId?: string; userId?: string; targetId?: string; from?: string }
  | { type: 'call-rejected'; roomId?: string; userId?: string; targetId?: string; from?: string }
  | { type: 'room-call'; roomId?: string; userId?: string; callType?: 'audio' | 'video' | string }
  | { type: 'room-call-accepted'; roomId?: string; userId?: string }
  | { type: 'room-call-rejected'; roomId?: string; userId?: string }
  | { type: 'room-call-end'; roomId?: string; userId?: string }
  | { type: 'room-call-join'; roomId?: string; userId?: string }
  | { type: 'kick'; roomId?: string; userId?: string; targetId?: string }
  | { type: 'leave'; roomId?: string; userId?: string }
  | { type: 'get-room-info'; payload?: { roomId?: string } }
  | { type: 'get-room-meta'; payload?: { roomId?: string } };

export type WsOutbound =
  | { type: 'room-created'; roomId: string; password: string | null }
  | { type: 'public-rooms'; rooms: Array<{ id: string; name: string; description: string; memberCount: number; isPrivate: boolean; isSecure: boolean }> }
  | { type: 'join-error'; error: string }
  | { type: 'user-joined'; userId: string; displayName: string }
  | { type: 'user-left'; userId: string; displayName: string }
  | { type: 'user-kicked'; userId: string }
  | { type: 'kicked'; roomId: string }
  | { type: 'admin-changed'; newAdminId: string }
  | { type: 'room-users'; users: string[] }
  | { type: 'lobby-users'; users: string[] }
  | { type: 'all-users'; users: Array<{ id: string; roomId: string }> }
  | { type: 'signal'; from: string; signal: unknown }
  | { type: 'chat-invite'; from: string; roomId: string }
  | { type: 'call'; callType: string; from: string; roomId: string }
  | { type: 'call-accepted'; from: string; roomId: string }
  | { type: 'call-missed'; from: string; roomId: string }
  | { type: 'call-rejected'; from: string; roomId: string }
  | { type: 'room-call'; callType: string; from: string; roomId: string; participants: string[]; rejectedUsers: string[]; leftUsers: string[] }
  | { type: 'room-call-accepted'; from: string; roomId: string; participants: string[]; rejectedUsers: string[]; leftUsers: string[] }
  | { type: 'room-call-rejected'; from: string; roomId: string; participants: string[]; rejectedUsers: string[]; leftUsers: string[] }
  | { type: 'room-call-end'; from: string; roomId: string; participants: string[]; rejectedUsers: string[]; leftUsers: string[] }
  | { type: 'room-call-join'; from: string; roomId: string; participants: string[]; rejectedUsers: string[]; leftUsers: string[] }
  | { type: 'room-info'; roomId: string; name: string; isSecure: boolean; isPrivate: boolean; description: string; exists: boolean }
  | { type: 'room-info-error'; error: string }
  | { type: 'room-meta'; roomId: string; name: string; adminId?: string };

