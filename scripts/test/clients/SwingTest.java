// SPDX-License-Identifier: GPL-2.0-or-later
// Java Swing scroll test client: java SwingTest.java "Title"
import javax.swing.*;
import java.awt.*;

public class SwingTest {
    public static void main(String[] args) {
        long start = System.nanoTime();
        SwingUtilities.invokeLater(() -> {
            JFrame frame = new JFrame(args.length > 0 ? args[0] : "Swing test");
            JPanel panel = new JPanel();
            panel.setPreferredSize(new Dimension(4000, 40000));
            JScrollPane scroll = new JScrollPane(panel);
            scroll.getVerticalScrollBar().addAdjustmentListener(e -> System.out.printf(
                "{\"t\":%d,\"ev\":\"position\",\"x\":0,\"y\":%d}%n", (System.nanoTime() - start) / 1000000, e.getValue()));
            frame.add(scroll);
            frame.setSize(900, 700);
            frame.setDefaultCloseOperation(JFrame.EXIT_ON_CLOSE);
            frame.setVisible(true);
            System.out.println("{\"t\":0,\"ev\":\"ready\"}");
        });
    }
}
