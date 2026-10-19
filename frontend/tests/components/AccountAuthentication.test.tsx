import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AddAccountForm from '../../src/components/Account/AddAccountForm';
import AccountDetail from '../../src/components/Account/AccountDetail';
import { authenticate } from '../../src/apple/authenticate';
import type { Account } from '../../src/types';

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  toast: vi.fn(),
  add: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  load: vi.fn(),
  email: 'test@example.invalid',
}));
const account: Account = {
  email: 'test@example.invalid',
  password: 'test-password',
  appleId: 'test@example.invalid',
  store: '143441',
  firstName: 'Test',
  lastName: 'User',
  passwordToken: 'test-token',
  directoryServicesIdentifier: '123',
  cookies: [],
  deviceIdentifier: 'aabbccddeeff',
};
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('react-router-dom', async (original) => ({
  ...(await original<typeof import('react-router-dom')>()),
  useNavigate: () => mocks.navigate,
  useParams: () => ({ email: mocks.email }),
}));
vi.mock('../../src/components/common/SapStatus', () => ({
  default: () => null,
}));
vi.mock('../../src/store/toast', () => ({
  useToastStore: (select: (state: unknown) => unknown) =>
    select({ addToast: mocks.toast }),
}));
vi.mock('../../src/hooks/useAccounts', () => ({
  useAccounts: () => ({
    accounts: [account, { ...account, email: 'other@example.invalid' }],
    loading: false,
    loadAccounts: mocks.load,
    addAccount: mocks.add,
    updateAccount: mocks.update,
    removeAccount: mocks.remove,
  }),
}));
vi.mock('../../src/apple/authenticate', () => ({
  authenticate: vi.fn(),
  AuthenticationError: class extends Error {},
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(authenticate).mockReset();
  mocks.email = account.email;
});
afterEach(() => cleanup());

function renderAdd() {
  const view = render(
    <MemoryRouter>
      <AddAccountForm />
    </MemoryRouter>,
  );
  fireEvent.change(screen.getByLabelText('accounts.addForm.email'), {
    target: { value: account.email },
  });
  fireEvent.change(screen.getByLabelText('accounts.addForm.password'), {
    target: { value: account.password },
  });
  return view;
}

describe('account authentication cancellation', () => {
  it('keeps cancel available during sign-in and lets the user retry without losing input', async () => {
    vi.mocked(authenticate).mockImplementation(
      (...args) =>
        new Promise((_resolve, reject) => {
          args[6]!.addEventListener('abort', () => reject(args[6]!.reason), {
            once: true,
          });
        }),
    );
    renderAdd();
    const submit = screen.getByRole('button', {
      name: 'accounts.addForm.signIn',
    });
    fireEvent.click(submit);
    expect(submit).toBeDisabled();
    const cancel = screen.getByRole('button', {
      name: 'accounts.addForm.cancel',
    });
    expect(cancel).toBeEnabled();
    fireEvent.click(cancel);
    await waitFor(() => expect(submit).toBeEnabled());
    expect(screen.getByLabelText('accounts.addForm.email')).toHaveValue(
      account.email,
    );
    expect(screen.getByLabelText('accounts.addForm.password')).toHaveValue(
      account.password,
    );
    expect(mocks.add).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalled();
    vi.mocked(authenticate).mockResolvedValueOnce(account);
    fireEvent.click(submit);
    await waitFor(() => expect(mocks.add).toHaveBeenCalledWith(account));
    expect(mocks.navigate).toHaveBeenCalledWith('/accounts');
  });

  it('aborts on leaving the add screen and ignores a late successful login', async () => {
    let complete!: (value: Account) => void;
    vi.mocked(authenticate).mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const view = renderAdd();
    fireEvent.click(
      screen.getByRole('button', { name: 'accounts.addForm.signIn' }),
    );
    const signal = vi.mocked(authenticate).mock.calls[0][6]!;
    view.unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => complete(account));
    expect(mocks.add).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it('allows cancelling re-authentication without updating or deleting the account', async () => {
    vi.mocked(authenticate).mockImplementation(
      (...args) =>
        new Promise((_resolve, reject) => {
          args[6]!.addEventListener('abort', () => reject(args[6]!.reason), {
            once: true,
          });
        }),
    );
    render(
      <MemoryRouter>
        <AccountDetail />
      </MemoryRouter>,
    );
    const submit = screen.getByRole('button', {
      name: 'accounts.detail.reauth',
    });
    fireEvent.click(submit);
    expect(
      screen.getByRole('button', { name: 'accounts.detail.delete' }),
    ).toBeDisabled();
    fireEvent.click(
      screen.getByRole('button', { name: 'accounts.detail.cancel' }),
    );
    await waitFor(() => expect(submit).toBeEnabled());
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it('ignores an old re-authentication result when the account route changes', async () => {
    let complete!: (value: Account) => void;
    vi.mocked(authenticate).mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const view = render(
      <MemoryRouter>
        <AccountDetail />
      </MemoryRouter>,
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'accounts.detail.reauth' }),
    );
    const signal = vi.mocked(authenticate).mock.calls[0][6]!;
    mocks.email = 'other@example.invalid';
    view.rerender(
      <MemoryRouter>
        <AccountDetail />
      </MemoryRouter>,
    );
    expect(signal.aborted).toBe(true);
    await act(async () => complete(account));
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalled();
    expect(
      screen.getByRole('button', { name: 'accounts.detail.reauth' }),
    ).toBeEnabled();
  });
});
