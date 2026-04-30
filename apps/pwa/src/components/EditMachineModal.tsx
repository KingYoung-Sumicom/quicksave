// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { useMachineStore, type Machine } from '../stores/machineStore';
import { Modal } from './ui/Modal';
import { MachineIcon } from './icons/MachineIcon';

interface EditMachineModalProps {
  machine: Machine;
  onClose: () => void;
}

export function EditMachineModal({ machine, onClose }: EditMachineModalProps) {
  const intl = useIntl();
  const [nickname, setNickname] = useState(machine.nickname);

  const { updateMachine } = useMachineStore();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    updateMachine(machine.agentId, {
      nickname: nickname.trim() || machine.nickname,
    });
    onClose();
  };

  return (
    <Modal title={intl.formatMessage({ id: 'settings.machines.edit.title' })} onClose={onClose}>
      <form onSubmit={handleSubmit} className="p-4 space-y-4">
          {/* Current Preview */}
          <div className="flex items-center gap-3 p-3 bg-slate-700/50 rounded-lg">
            <div className="w-10 h-10 bg-slate-700 rounded-lg flex items-center justify-center text-slate-300">
              <MachineIcon className="w-5 h-5" />
            </div>
            <div>
              <p className="font-medium">{nickname || machine.nickname}</p>
              <p className="text-xs text-slate-400 font-mono">{machine.agentId.slice(0, 16)}...</p>
            </div>
          </div>

          {/* Nickname */}
          <div>
            <label htmlFor="nickname" className="block text-sm font-medium text-slate-300 mb-1">
              <FormattedMessage id="settings.machines.edit.nickname.label" />
            </label>
            <input
              id="nickname"
              type="text"
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              placeholder={intl.formatMessage({ id: 'settings.machines.edit.nickname.placeholder' })}
              className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-md text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>

          {/* Actions */}
          <div className="flex gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 py-3 px-4 bg-slate-700 hover:bg-slate-600 rounded-md font-medium text-white transition-colors"
            >
              <FormattedMessage id="common.cancel" />
            </button>
            <button
              type="submit"
              className="flex-1 py-3 px-4 bg-blue-600 hover:bg-blue-700 rounded-md font-medium text-white transition-colors"
            >
              <FormattedMessage id="settings.machines.edit.save" />
            </button>
          </div>
        </form>
    </Modal>
  );
}
