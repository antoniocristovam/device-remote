import { useEffect, useState } from 'react';
import { onRcEvent, rc, type ChatEntry, type Transfer } from './rc';

/** Chat timeline + in-flight transfers for one paired desktop, kept live by native events. */
export function useChat(fingerprint: string | undefined, visible: boolean) {
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    if (!fingerprint) {
      setEntries([]);
      setTransfers([]);
      return;
    }
    let alive = true;
    rc.getChat(fingerprint).then((e) => alive && setEntries(e));
    rc.getTransfers().then((t) => alive && setTransfers(t));
    const off = onRcEvent((e) => {
      if (e.type === 'chatEntry' && e.payload.peer === fingerprint) {
        const entry = e.payload.entry;
        setEntries((list) => {
          const isNew = !list.some((x) => x.id === entry.id);
          if (isNew && entry.from === 'peer') setUnread((n) => n + 1);
          return [...list.filter((x) => x.id !== entry.id), entry];
        });
      }
      if (e.type === 'transfers' && e.payload.peer === fingerprint) setTransfers(e.payload.list);
    });
    return () => {
      alive = false;
      off();
    };
  }, [fingerprint]);

  useEffect(() => {
    if (visible) setUnread(0);
  }, [visible, unread]);

  return { entries, transfers, unread };
}
