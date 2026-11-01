'use client';
import {Component} from 'react';

export class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = {hasError: false, error: null};
  }

  static getDerivedStateFromError(error) {
    return {hasError: true, error};
  }

  componentDidCatch(error, errorInfo) {
    console.error('Workspace error:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <main className="loading">
          <div className="symbol">!</div>
          <h1>页面加载遇到问题</h1>
          <p role="alert">{this.state.error?.message || '请刷新页面重试'}</p>
          <button onClick={() => window.location.reload()}>刷新页面</button>
        </main>
      );
    }

    return this.props.children;
  }
}
