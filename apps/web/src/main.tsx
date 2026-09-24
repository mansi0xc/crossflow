import './polyfill.js';
import { Component, StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.js';
import './styles.css';

/**
 * A render error anywhere in the tree must not leave a blank page: the user needs to know that
 * nothing was signed and that recovery is still available from a fresh load.
 */
class ErrorBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(error: unknown) {
    return { error: String((error as Error)?.message ?? error) };
  }
  render() {
    if (this.state.error) {
      return (
        <div className="app">
          <h1>CrossFlow</h1>
          <p className="error" data-testid="ui-error">
            The interface stopped with an error: {this.state.error}
          </p>
          <p className="note">
            Nothing was signed as a result of this. Reloading is safe: intent state lives on chain,
            and recovery needs only your wallet.
          </p>
        </div>
      );
    }
    return this.props.children;
  }
}

const container = document.getElementById('root');
if (!container) throw new Error('root container missing');
createRoot(container).render(<StrictMode><ErrorBoundary><App /></ErrorBoundary></StrictMode>);
