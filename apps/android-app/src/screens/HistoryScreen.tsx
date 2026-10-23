import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, SectionList, Text, View } from 'react-native';
import { onRcEvent, rc, type SessionLogEntry } from '../native/rc';
import { colors, radius } from '../theme';
import { Card, styles } from '../components/ui';

/** End reasons from this phone's point of view. */
const REASONS: Record<string, { label: string; color: string }> = {
  user: { label: 'Encerrada pelo computador', color: colors.muted },
  revoked: { label: 'Encerrada neste aparelho', color: colors.warn },
  lost: { label: 'Conexão perdida', color: colors.danger },
  expired: { label: 'Sessão expirada', color: colors.muted },
  error: { label: 'Erro', color: colors.danger },
};

function duration(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return `${h}h ${m}min`;
  return m ? `${m}min ${s % 60}s` : `${s}s`;
}
const hm = (ts: number) => new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
function dayLabel(ts: number) {
  const d = new Date(ts).toDateString();
  if (d === new Date().toDateString()) return 'Hoje';
  if (d === new Date(Date.now() - 86_400_000).toDateString()) return 'Ontem';
  return new Date(ts).toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long' });
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ flex: 1, backgroundColor: colors.panel, borderColor: colors.line, borderWidth: 1, borderRadius: radius.md, padding: 12 }}>
      <Text style={{ color: colors.dim, fontSize: 11, letterSpacing: 0.6, textTransform: 'uppercase' }}>{label}</Text>
      <Text style={{ color: colors.fg, fontSize: 17, fontFamily: 'monospace', marginTop: 2 }}>{value}</Text>
    </View>
  );
}

export function HistoryScreen() {
  const [rows, setRows] = useState<SessionLogEntry[]>([]);
  const [device, setDevice] = useState<string>('all');
  const [now, setNow] = useState(Date.now());

  const load = useCallback(() => {
    rc.getHistory().then(setRows);
  }, []);

  useEffect(() => {
    load();
    // Sessions start and end while the screen is open: keep the audit log current.
    const off = onRcEvent((e) => {
      if (e.type === 'sessionEnded' || (e.type === 'state' && e.payload.session.phase === 'live')) load();
    });
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      off();
      clearInterval(t);
    };
  }, [load]);

  const devices = useMemo(() => [...new Map(rows.map((r) => [r.peerFingerprint, r.peerName]))], [rows]);
  const visible = device === 'all' ? rows : rows.filter((r) => r.peerFingerprint === device);
  const sections = useMemo(() => {
    const g = new Map<string, SessionLogEntry[]>();
    for (const r of visible) {
      const k = new Date(r.startedAt).toDateString();
      g.set(k, [...(g.get(k) ?? []), r]);
    }
    return [...g.values()].map((data) => ({ title: dayLabel(data[0]!.startedAt), data }));
  }, [visible]);
  const totalMs = visible.reduce((n, r) => n + ((r.endedAt ?? now) - r.startedAt), 0);

  return (
    <SectionList
      sections={sections}
      keyExtractor={(r) => r.sid}
      stickySectionHeadersEnabled={false}
      contentContainerStyle={{ padding: 20, paddingBottom: 40 }}
      ListHeaderComponent={
        <View style={{ marginBottom: 8 }}>
          <Text style={styles.h1}>Histórico</Text>
          <Text style={[styles.body, { marginTop: 4 }]}>Quando, por quem e por quanto tempo este aparelho foi controlado.</Text>
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 16 }}>
            <Stat label="Sessões" value={String(visible.length)} />
            <Stat label="Tempo total" value={duration(totalMs)} />
            <Stat label="Quedas" value={String(visible.reduce((n, r) => n + (r.reconnects ?? 0), 0))} />
          </View>
          {devices.length > 1 && (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 14 }}>
              {[['all', 'Todos'] as [string, string], ...devices].map(([fp, name]) => (
                <Pressable
                  key={fp}
                  onPress={() => setDevice(fp)}
                  style={{
                    paddingHorizontal: 12,
                    paddingVertical: 6,
                    borderRadius: 999,
                    borderWidth: 1,
                    borderColor: device === fp ? colors.accent : colors.line,
                    backgroundColor: device === fp ? '#1f1a3a' : 'transparent',
                  }}
                >
                  <Text style={{ color: device === fp ? colors.fg : colors.muted, fontSize: 13 }}>{name}</Text>
                </Pressable>
              ))}
            </View>
          )}
        </View>
      }
      renderSectionHeader={({ section }) => (
        <Text style={{ color: colors.dim, fontSize: 12, fontWeight: '600', letterSpacing: 0.6, textTransform: 'uppercase', marginTop: 18, marginBottom: 8 }}>
          {section.title}
        </Text>
      )}
      ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
      ListEmptyComponent={<Text style={[styles.body, { marginTop: 16 }]}>Nenhuma sessão registrada.</Text>}
      renderItem={({ item }) => {
        const live = !item.endedAt;
        const reason = item.endReason ? REASONS[item.endReason] ?? { label: item.endReason, color: colors.muted } : undefined;
        return (
          <Card style={live ? { borderColor: colors.danger } : undefined}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <Text style={[styles.text, { fontWeight: '600', flex: 1 }]} numberOfLines={1}>
                {item.peerName}
              </Text>
              <Text style={{ color: colors.fg, fontFamily: 'monospace' }}>{duration((item.endedAt ?? now) - item.startedAt)}</Text>
            </View>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 }}>
              <Text style={{ color: colors.muted, fontFamily: 'monospace', fontSize: 12 }}>
                {hm(item.startedAt)} – {item.endedAt ? hm(item.endedAt) : 'agora'}
                {(item.reconnects ?? 0) > 0 ? `  ·  ${item.reconnects} ${item.reconnects === 1 ? 'queda' : 'quedas'}` : ''}
              </Text>
              <Text style={{ color: live ? colors.danger : reason?.color ?? colors.muted, fontSize: 12 }}>
                {live ? '● em andamento' : reason?.label}
              </Text>
            </View>
          </Card>
        );
      }}
    />
  );
}
