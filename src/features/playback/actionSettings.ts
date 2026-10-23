import { INITIAL_SETTINGS, type ActionChoice, type ActionSettings } from '@/domain/playback/actions';

export type SettingsEvent =
  | { type: 'master'; enabled: boolean }
  | { type: 'default'; choice: ActionSettings['defaultChoice'] }
  | { type: 'choose'; key: string; choice: ActionChoice }
  /** Forget the user's choice for one finding (undo an ignore, or go back to the default). */
  | { type: 'clear'; key: string }
  | { type: 'reset' };

/** Pure reducer for the user's overrides. In memory only: nothing is persisted or sent anywhere. */
export function settingsReducer(state: ActionSettings, event: SettingsEvent): ActionSettings {
  switch (event.type) {
    case 'master': return state.autoEnabled === event.enabled ? state : { ...state, autoEnabled: event.enabled };
    case 'default': return state.defaultChoice === event.choice ? state : { ...state, defaultChoice: event.choice };
    case 'choose': return { ...state, choices: { ...state.choices, [event.key]: event.choice } };
    case 'clear': {
      if (!Object.hasOwn(state.choices, event.key)) return state;
      const { [event.key]: _removed, ...rest } = state.choices;
      void _removed;
      return { ...state, choices: rest };
    }
    case 'reset': return INITIAL_SETTINGS;
  }
}
