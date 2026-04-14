import { useState, useEffect } from 'react';
import { Modal } from './ui/Modal';
import { Spinner } from './ui/Spinner';
import { ErrorBox } from './ui/ErrorBox';

interface GitIdentityModalProps {
  onClose: () => void;
  onSave: (name: string, email: string) => Promise<boolean>;
  onGetIdentity: () => Promise<{ name?: string; email?: string }>;
}

export function GitIdentityModal({ onClose, onSave, onGetIdentity }: GitIdentityModalProps) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [fetching, setFetching] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    onGetIdentity().then((identity) => {
      if (identity.name) setName(identity.name);
      if (identity.email) setEmail(identity.email);
    }).finally(() => setFetching(false));
  }, [onGetIdentity]);

  const handleSave = async () => {
    const trimmedName = name.trim();
    const trimmedEmail = email.trim();

    if (!trimmedName) {
      setError('Name is required');
      return;
    }
    if (!trimmedEmail) {
      setError('Email is required');
      return;
    }

    setLoading(true);
    setError(null);

    const success = await onSave(trimmedName, trimmedEmail);
    setLoading(false);

    if (success) {
      onClose();
    } else {
      setError('Failed to save git identity');
    }
  };

  return (
    <Modal title="Set Up Git Identity" onClose={onClose} backdropClose={!loading}>
      <div className="p-4 space-y-4">
        <p className="text-sm text-slate-300">
          Git requires a name and email to create commits. This will be saved in the repository's local git config.
        </p>

        {fetching ? (
          <div className="flex items-center justify-center py-4">
            <Spinner />
          </div>
        ) : (
          <>
            <div className="space-y-3">
              <div>
                <label htmlFor="git-name" className="block text-sm font-medium text-slate-300 mb-1">
                  Name
                </label>
                <input
                  id="git-name"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Your Name"
                  className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-md text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  disabled={loading}
                  autoFocus
                />
              </div>

              <div>
                <label htmlFor="git-email" className="block text-sm font-medium text-slate-300 mb-1">
                  Email
                </label>
                <input
                  id="git-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-md text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  disabled={loading}
                />
              </div>
            </div>

            {error && <ErrorBox>{error}</ErrorBox>}

            <div className="flex gap-3">
              <button
                onClick={onClose}
                disabled={loading}
                className="flex-1 py-2 px-4 bg-slate-700 hover:bg-slate-600 disabled:bg-slate-700 disabled:cursor-not-allowed rounded-md font-medium text-white transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={loading || !name.trim() || !email.trim()}
                className="flex-1 py-2 px-4 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-600 disabled:cursor-not-allowed rounded-md font-medium text-white transition-colors flex items-center justify-center gap-2"
              >
                {loading ? (
                  <>
                    <Spinner color="border-white" />
                    Saving...
                  </>
                ) : (
                  'Save'
                )}
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
