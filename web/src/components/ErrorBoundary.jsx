import { Component } from 'react';

// Catches a crash inside one page so the header and navigation keep working: the page shows
// what went wrong with a "Try again" button instead of the whole app going blank until a reload.
// Give it a `key` that changes with the route so moving to another page starts fresh.
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
    this.reset = () => this.setState({ error: null });
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('Page crashed:', error, info?.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="card empty is-centered" role="alert" aria-live="assertive">
        <h2>This page hit a problem</h2>
        <p className="small">{String(error?.message || error)}</p>
        <div className="dialog-actions" style={{ justifyContent: 'center' }}>
          <button type="button" className="btn btn-primary" onClick={this.reset}>
            Try again
          </button>
          <button type="button" className="btn" onClick={() => window.location.reload()}>
            Reload the app
          </button>
        </div>
      </div>
    );
  }
}
