// Ошибка в отрисовке не должна оставлять пустое окно: показываем её и даём перезагрузить.
import { Component, type ReactNode } from 'react'

export class ErrorBoundary extends Component<{ children: ReactNode }, { error?: Error }> {
  state: { error?: Error } = {}
  static getDerivedStateFromError(error: Error) { return { error } }
  componentDidCatch(error: Error, info: { componentStack?: string | null }) { console.error(error, info.componentStack) }
  render() {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="crash">
        <h3>Что-то сломалось в интерфейсе</h3>
        <pre>{error.message}</pre>
        <div className="toggles">
          <button className="primary" onClick={() => this.setState({ error: undefined })}>Вернуться</button>
          <button className="ghost" onClick={() => location.reload()}>Перезагрузить</button>
        </div>
      </div>
    )
  }
}
